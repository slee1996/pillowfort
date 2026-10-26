/** Browser-shaped socket backed by Workers' supported outbound fetch upgrade API. */
class OutboundParticipantSocket {
  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  private socket?: WebSocket;
  private readonly abort = new AbortController();
  // Workers EventTarget dispatch also invokes onmessage attributes. Keep listener
  // dispatch separate from this adapter's attributes to deliver each frame once.
  private readonly events = new EventTarget();

  constructor(url: string) {
    this.url = url;
    void this.connect();
  }

  addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.events.addEventListener(...args);
  }

  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.events.removeEventListener(...args);
  }

  private async connect() {
    try {
      const url = new URL(this.url);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid WebSocket protocol.');
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      const response = await fetch(url, { headers: { Upgrade: 'websocket', Origin: url.origin }, redirect: 'manual', signal: this.abort.signal });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        await response.body?.cancel();
        throw new Error('WebSocket upgrade failed.');
      }
      this.socket = socket;
      // A fetch upgrade can settle after cancellation. Accept solely to close it;
      // never expose a late connection or allow it to create a fresh identity.
      if (this.readyState !== 0) {
        socket.accept();
        socket.close(1000, 'Participant closed');
        return;
      }
      socket.addEventListener('message', event => {
        if (this.readyState !== 1) return;
        const message = new MessageEvent('message', { data: event.data });
        this.onmessage?.(message);
        this.events.dispatchEvent(message);
      });
      socket.addEventListener('error', () => {
        if (this.readyState === 3) return;
        this.error();
        this.close(1011, 'Connection failed');
      });
      socket.addEventListener('close', event => this.finish(event.code, event.reason, event.wasClean));
      this.readyState = 1;
      socket.accept();
      if (this.readyState !== 1) return;
      const event = new Event('open');
      this.onopen?.(event);
      this.events.dispatchEvent(event);
    } catch {
      if (this.readyState === 3) return;
      this.error();
      this.finish(1006, 'WebSocket connection failed', false);
    }
  }

  private error() {
    const event = new Event('error');
    this.onerror?.(event);
    this.events.dispatchEvent(event);
  }

  private finish(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new CloseEvent('close', { code, reason, wasClean });
    this.onclose?.(event);
    this.events.dispatchEvent(event);
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1 || !this.socket) throw new Error('WebSocket is not open.');
    this.socket.send(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.abort.abort();
    try { this.socket?.close(code, reason); }
    finally { this.finish(code, reason, true); }
  }
}

export function createWorkerWebSocket(url: string): WebSocket {
  // The shared controller consumes only the standard socket event/send/close surface.
  return new OutboundParticipantSocket(url) as unknown as WebSocket;
}
