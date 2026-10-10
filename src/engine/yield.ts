/**
 * Yield to the event loop so queued messages (CANCEL frames, UI control) run, without
 * setTimeout's clamping. One MessageChannel per thread; each call posts one message and
 * resolves when it is delivered, i.e. after every task queued before it.
 */
let channel: MessageChannel | undefined;
const waiting: Array<() => void> = [];

function port(): MessagePort {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => { waiting.shift()?.(); };
    // Node keeps the process alive while a port with a listener is referenced.
    (channel.port1 as unknown as { unref?: () => void }).unref?.();
    (channel.port2 as unknown as { unref?: () => void }).unref?.();
  }
  return channel.port2;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { waiting.push(resolve); port().postMessage(null); });
}
