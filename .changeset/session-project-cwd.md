---
"@vndv/pi-codegraph": patch
---

Default native CodeGraph tools to the current Pi execution context's working directory instead of the host process cwd. Preserve explicit project overrides and use one validated project path for file filters, MCP launch, initialization, and tool arguments. Reject explicit empty paths instead of silently selecting another project.
