'use strict';

/** A tool-level failure: returned to the MCP client as isError, never thrown into HTTP. */
class ToolError extends Error {
  constructor(message) {
    super(String(message || 'tool failed'));
    this.name = 'ToolError';
    this.isToolError = true;
  }
}

module.exports = { ToolError };
