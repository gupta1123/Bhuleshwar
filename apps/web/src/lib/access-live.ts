export async function consumeAccessEvents(response: Response, onEvent: (type: string, data: Record<string, unknown>) => void) {
  if (!response.ok || !response.body) throw new Error('Access notifications unavailable');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 65536) throw new Error('Invalid access event stream');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
        if (type && data) onEvent(type, JSON.parse(data));
      }
    }
  } finally { reader.releaseLock(); }
}
