import type { AgentTool, Tool, ToolCallResult, ToolDefinition } from './types';
import { isCancellation, waitWithSignal } from '../utils/cancellation';
import { createLogger } from '../utils/logger';

const log = createLogger('Tools');

/** Default time a tool handler may take before the model gets a timeout error. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** Tool rounds per turn; the request after the last round asks for a text answer. */
export const MAX_TOOL_ROUNDS = 3;
/** Longest tool result sent to the model, in characters. */
export const MAX_TOOL_RESULT_CHARS = 16_000;

export interface ToolSet {
  /** Definitions sent to the model. */
  definitions: ToolDefinition[];
  /** Tools the agent runs itself, by function name. */
  handlers: Map<string, AgentTool>;
}

function isAgentTool(tool: Tool): tool is AgentTool {
  return typeof (tool as AgentTool).handler === 'function';
}

export function toolSet(tools: Tool[] = []): ToolSet {
  const definitions: ToolDefinition[] = [];
  const handlers = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (isAgentTool(tool)) {
      definitions.push(tool.definition);
      handlers.set(tool.definition.function.name, tool);
    } else {
      definitions.push(tool);
    }
  }
  return { definitions, handlers };
}

function encodeResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated]`
    : text;
}

const errorResult = (message: string) => JSON.stringify({ error: message });

/**
 * Runs one tool call and returns the text for the model. Handler errors, bad arguments and
 * timeouts become `{"error": ...}` results. Only cancellation of the turn itself throws.
 */
export async function runTool(tool: AgentTool, call: ToolCallResult, turn: AbortSignal): Promise<string> {
  let args: unknown;
  try {
    args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return errorResult('Arguments are not valid JSON');
  }
  const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const controller = new AbortController();
  const onTurnAbort = () => controller.abort(turn.reason);
  if (turn.aborted) onTurnAbort();
  else turn.addEventListener('abort', onTurnAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Tool timed out after ${timeoutMs} ms`, 'TimeoutError'));
  }, timeoutMs);
  const started = performance.now();
  try {
    // waitWithSignal returns on abort even if the handler ignores its signal.
    const value = await waitWithSignal(
      Promise.resolve().then(() => tool.handler(args, { signal: controller.signal, call })),
      controller.signal,
    );
    log.info(`tool ${call.name}: ${(performance.now() - started).toFixed(0)}ms`);
    return encodeResult(value);
  } catch (error) {
    if (turn.aborted && isCancellation(error, turn)) throw error;
    if (controller.signal.aborted && !turn.aborted) {
      log.warn(`tool ${call.name} timed out after ${timeoutMs}ms`);
      return errorResult(`Tool timed out after ${timeoutMs} ms`);
    }
    if (turn.aborted) throw turn.reason;
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`tool ${call.name} failed: ${message}`);
    return errorResult(message || 'Tool failed');
  } finally {
    clearTimeout(timer);
    turn.removeEventListener('abort', onTurnAbort);
  }
}
