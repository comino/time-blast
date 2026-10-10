import { describe, expect, it, vi } from 'vitest';
import { prepareQueryGrammar } from '../src/inference/grammar-warmup';
import { modelPlanContract } from '../src/inference/model-contract';
import { modelGenerationOptions } from '../src/inference/model-output';

describe('query grammar preparation through the public engine API', () => {
  it.each(['Qwen2.5-0.5B-Instruct', 'Qwen2.5-1.5B-Instruct', 'Qwen3-4B']
    .flatMap(name => ['16', '32'].map(precision => `${name}-q4f${precision}_1-MLC`)))
  ('warms exactly the selected %s contract with one token and no user data', async model => {
    // Deliberately incomplete output: preparation neither parses nor repairs it.
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] });
    const resetChat = vi.fn().mockResolvedValue(undefined);
    await prepareQueryGrammar({ chat: { completions: { create } }, resetChat }, model);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      ...modelGenerationOptions(model), messages: [{ role: 'user', content: 'Return JSON.' }],
      stream: false, temperature: 0, max_tokens: 1,
      response_format: { type: 'json_object', schema: modelPlanContract(model).schema },
    });
    expect(resetChat).toHaveBeenCalledExactlyOnceWith();
  });

  it('waits for completion and chat reset before resolving preparation', async () => {
    let finishCompletion!: () => void, finishReset!: () => void;
    const create = vi.fn().mockReturnValue(new Promise<void>(resolve => { finishCompletion = resolve; }));
    const resetChat = vi.fn().mockReturnValue(new Promise<void>(resolve => { finishReset = resolve; }));
    let finished = false;
    const task = prepareQueryGrammar({ chat: { completions: { create } }, resetChat }, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC')
      .then(() => { finished = true; });
    await Promise.resolve();
    expect(resetChat).not.toHaveBeenCalled(); expect(finished).toBe(false);
    finishCompletion(); await vi.waitFor(() => expect(resetChat).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    finishReset(); await task;
    expect(finished).toBe(true);
  });

  it.each(['completion', 'reset'])('propagates a %s failure without another generation', async phase => {
    const error = new Error(`Failed ${phase}`);
    const create = vi.fn().mockResolvedValue({});
    const resetChat = vi.fn().mockResolvedValue(undefined);
    if (phase === 'completion') create.mockRejectedValue(error);
    else resetChat.mockRejectedValue(error);
    await expect(prepareQueryGrammar({ chat: { completions: { create } }, resetChat }, 'Qwen3-4B-q4f16_1-MLC')).rejects.toBe(error);
    expect(create).toHaveBeenCalledOnce();
    expect(resetChat).toHaveBeenCalledTimes(phase === 'completion' ? 0 : 1);
  });
});
