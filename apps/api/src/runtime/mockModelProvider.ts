import type { ModelProvider } from "../domain/ports.js";

export class DeterministicModelProvider implements ModelProvider {
  async complete(input: Parameters<ModelProvider["complete"]>[0]): ReturnType<ModelProvider["complete"]> {
    const memoryNotes = input.context.map((record) => record.content).slice(0, 3);
    const plan = [
      "Understand the task goal",
      "Retrieve relevant memory",
      "Use enabled tools when they reduce uncertainty",
      "Produce a traceable final result"
    ];

    const output = {
      agentId: input.agent.id,
      executionId: input.execution.id,
      model: input.agent.model,
      plan,
      memoryInfluence: memoryNotes,
      result: `Completed task for goal: ${input.agent.goal}`
    };

    const promptTokens = Math.max(8, Math.ceil(input.prompt.length / 4));
    const completionTokens = Math.ceil(JSON.stringify(output).length / 4);

    return {
      output,
      tokenUsage: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens
      }
    };
  }
}
