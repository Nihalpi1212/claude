// AI accounts and requests (see ARCHITECTURE.md "0.2 features: AI"). Placeholder until lib/ai lands:
// every method answers "not available" so the renderer can show the right state.
export function createAi() {
  return {
    async dispatch(method) {
      if (method === 'status') return { available: false, encryption: false, openai: { method: null }, gemini: { method: null } };
      throw new Error(`AI is not available in this build (${method})`);
    },
  };
}
