import { z } from 'zod';
import type { AnyTool } from './types';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, accepted by both Gemini and OpenAI-style APIs. */
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(...tools: AnyTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** Tool definitions sent to the LLM. Blocked tools are never offered. */
  specs(): ToolSpec[] {
    return this.list()
      .filter((t) => t.risk !== 'blocked')
      .map((t) => {
        const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.input) as Record<
          string,
          unknown
        >;
        return { name: t.name, description: t.description, parameters };
      });
  }
}
