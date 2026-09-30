import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import codegraphExtension, { callCodeGraphTool, normalizeWindowsPath } from "../extensions/codegraph.js";

type Request = { id?: number; method: string; params?: any };
type Launch = { command: string; args: string[]; cwd: string; requests: Request[] };

const cases = [
  { name: "codegraph_search", params: { query: "Example" } },
  { name: "codegraph_callers", params: { symbol: "Example" } },
  { name: "codegraph_callees", params: { symbol: "Example" } },
  { name: "codegraph_impact", params: { symbol: "Example" } },
  { name: "codegraph_explore", params: { query: "Example" } },
  { name: "codegraph_node", params: { symbol: "Example" } },
  { name: "codegraph_status", params: {} },
  { name: "codegraph_files", params: { path: "src" } },
];

function createMockProcess(launch: Launch) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => { child.killed = true; }),
  });
  child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n").filter(Boolean)) {
      const request = JSON.parse(line) as Request;
      launch.requests.push(request);
      if (request.method === "initialize" || request.method === "tools/call") {
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "initialize" ? {} : { content: [{ type: "text", text: "ok" }] },
        }) + "\n");
      }
    }
  });
  return child;
}

function context(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function expectProject(launch: Launch, cwd: string, name: string) {
  expect(launch.cwd).toBe(cwd);
  if (process.platform === "win32") {
    expect(launch.command).toBe("powershell.exe");
    expect(launch.args.at(-1)).toBe(cwd);
    expect(launch.args[launch.args.indexOf("-Command") + 1]).toContain("--path $ProjectPath");
  } else {
    expect(launch.command).toBe("codegraph");
    expect(launch.args).toEqual(["serve", "--mcp", "--path", cwd]);
  }
  const initialize = launch.requests.find(request => request.method === "initialize")!;
  expect(initialize.params.rootUri).toBe(pathToFileURL(cwd).href);
  expect(initialize.params.workspaceFolders[0].uri).toBe(pathToFileURL(cwd).href);
  const call = launch.requests.find(request => request.method === "tools/call")!;
  expect(call.params.name).toBe(name);
  expect(call.params.arguments.projectPath).toBe(cwd);
  return call.params.arguments;
}

describe("Pi session project routing", () => {
  let fixture: string;
  let hostCwd: string;
  let sessionCwd: string;
  let otherCwd: string;
  let tools: Map<string, ToolDefinition<any>>;
  let launches: Launch[];

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "pi-codegraph-session-"));
    hostCwd = path.join(fixture, "host");
    sessionCwd = path.join(fixture, "session");
    otherCwd = path.join(fixture, "other");
    await Promise.all([hostCwd, sessionCwd, otherCwd].map(cwd => mkdir(cwd)));
    tools = new Map();
    codegraphExtension({
      on: vi.fn(),
      registerTool: (tool: ToolDefinition<any>) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI);
  });

  beforeEach(() => {
    launches = [];
    spawnMock.mockClear();
    spawnMock.mockImplementation((command, args, options) => {
      const launch: Launch = { command, args, cwd: options.cwd, requests: [] };
      launches.push(launch);
      return createMockProcess(launch);
    });
    vi.spyOn(process, "cwd").mockReturnValue(hostCwd);
  });

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

  it.each(cases)("defaults $name to session cwd, not host cwd", async ({ name, params }) => {
    const result = await tools.get(name)!.execute("call", params, undefined, undefined, context(sessionCwd));
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(launches).toHaveLength(1);
    expectProject(launches[0], sessionCwd, name);
  });

  it.each(cases)("explicit projectPath overrides session cwd for $name", async ({ name, params }) => {
    await tools.get(name)!.execute("call", { ...params, projectPath: otherCwd }, undefined, undefined, context(sessionCwd));
    expect(launches).toHaveLength(1);
    expectProject(launches[0], otherCwd, name);
  });

  it.each(["linux", "win32"] as const)("routes default and explicit CLI project arguments on %s", async platform => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const tool = tools.get("codegraph_status")!;
    await tool.execute("default", {}, undefined, undefined, context(sessionCwd));
    await tool.execute("override", { projectPath: otherCwd }, undefined, undefined, context(sessionCwd));
    expect(launches).toHaveLength(2);
    expectProject(launches[0], sessionCwd, "codegraph_status");
    expectProject(launches[1], otherCwd, "codegraph_status");
  });

  it("uses the same session project for absolute file filters and MCP requests without mutating input", async () => {
    const params = Object.freeze({ path: path.join(sessionCwd, "src", "components") });
    await tools.get("codegraph_files")!.execute("call", params, undefined, undefined, context(sessionCwd));
    const args = expectProject(launches[0], sessionCwd, "codegraph_files");
    expect(args.path).toBe("src/components");
    expect(params).toEqual({ path: path.join(sessionCwd, "src", "components") });
  });

  it("uses the explicit project for file filters even when the session points elsewhere", async () => {
    await tools.get("codegraph_files")!.execute("call", {
      projectPath: otherCwd,
      path: path.join(otherCwd, "src"),
    }, undefined, undefined, context(sessionCwd));
    expect(expectProject(launches[0], otherCwd, "codegraph_files").path).toBe("src");
  });

  it("drops a file filter equal to the session root", async () => {
    await tools.get("codegraph_files")!.execute("call", { path: sessionCwd }, undefined, undefined, context(sessionCwd));
    expect(expectProject(launches[0], sessionCwd, "codegraph_files")).not.toHaveProperty("path");
  });

  it("reads the context on each call rather than retaining the first session", async () => {
    const tool = tools.get("codegraph_status")!;
    await tool.execute("first", {}, undefined, undefined, context(sessionCwd));
    await tool.execute("second", {}, undefined, undefined, context(otherCwd));
    expect(launches).toHaveLength(2);
    expectProject(launches[0], sessionCwd, "codegraph_status");
    expectProject(launches[1], otherCwd, "codegraph_status");
  });

  it("keeps concurrent session calls separate and does not change the process cwd", async () => {
    const chdir = vi.spyOn(process, "chdir");
    const tool = tools.get("codegraph_status")!;
    await Promise.all([
      tool.execute("first", {}, undefined, undefined, context(sessionCwd)),
      tool.execute("second", {}, undefined, undefined, context(otherCwd)),
    ]);
    expect(launches).toHaveLength(2);
    for (const cwd of [sessionCwd, otherCwd]) {
      expectProject(launches.find(launch => launch.cwd === cwd)!, cwd, "codegraph_status");
    }
    expect(chdir).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(hostCwd);
  });

  it.each(["", "   ", "relative/project"])("rejects explicit invalid path %j without falling back to host or session", async projectPath => {
    await expect(tools.get("codegraph_status")!.execute("call", { projectPath }, undefined, undefined, context(sessionCwd)))
      .rejects.toThrow("absolute path");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects an inaccessible session project without falling back to the host", async () => {
    await expect(tools.get("codegraph_status")!.execute("call", {}, undefined, undefined, context(path.join(fixture, "missing"))))
      .rejects.toThrow("does not exist");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("normalizes the selected project before launch, handshake, and forwarding", async () => {
    const projectPath = `  ${otherCwd}  `;
    await tools.get("codegraph_status")!.execute("call", { projectPath }, undefined, undefined, context(sessionCwd));
    expectProject(launches[0], normalizeWindowsPath(otherCwd), "codegraph_status");
  });

  it("retains process cwd as the default only for standalone helpers without a Pi context", async () => {
    await callCodeGraphTool("codegraph_status", {});
    expectProject(launches[0], hostCwd, "codegraph_status");
  });
});
