const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function failure(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

async function getJson(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`HTTP ${response.status} from ${url.pathname}`);
  return response.json();
}

export async function connectStudio(address) {
  let endpoint;
  try {
    endpoint = new URL(address);
  } catch (error) {
    throw failure("INVALID_CDP_ENDPOINT", "Supply an explicit HTTP loopback CDP endpoint with a port", error);
  }
  if (endpoint.protocol !== "http:" || !loopback.has(endpoint.hostname) || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw failure("INVALID_CDP_ENDPOINT", "Supply an explicit HTTP loopback CDP endpoint with a port");
  }
  let socket;
  try {
    const pages = await getJson(new URL("/json/list", endpoint));
    const studios = pages.filter(page => page.type === "page" && page.title === "Forge3D Studio");
    if (studios.length !== 1) throw Error(`Expected one Studio page, found ${studios.length}`);
    const [page] = studios;
    const app = new URL(page.url);
    const websocket = new URL(page.webSocketDebuggerUrl);
    if (app.protocol !== "http:" || !loopback.has(app.hostname) || websocket.protocol !== "ws:"
      || !loopback.has(websocket.hostname) || websocket.port !== endpoint.port) {
      throw Error("Expected a local Studio dev page and a loopback page WebSocket on the supplied port");
    }
    socket = new WebSocket(websocket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Timed out opening CDP WebSocket")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(Error("Could not open CDP WebSocket"));
      }, { once: true });
    });
    return new Session(socket, page, endpoint.origin);
  } catch (error) {
    socket?.close();
    throw failure("CDP_CONNECTION_ERROR", `${endpoint.origin} · ${error.message}`, error);
  }
}

class Session {
  requests = new Map();
  listeners = new Map();
  id = 0;

  constructor(socket, page, endpoint) {
    this.socket = socket;
    this.page = page;
    this.endpoint = endpoint;
    socket.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data);
      if (reply.id !== undefined) {
        const request = this.requests.get(reply.id);
        if (!request) return;
        const { method, resolve, reject, timer } = request;
        clearTimeout(timer);
        this.requests.delete(reply.id);
        if (reply.error) reject(failure("CDP_COMMAND_ERROR", `${method} · ${reply.error.message}`));
        else resolve(reply.result);
      } else {
        this.listeners.get(reply.method)?.(reply.params, reply.sessionId);
      }
    });
    socket.addEventListener("close", () => {
      for (const { timer, reject } of this.requests.values()) {
        clearTimeout(timer);
        reject(failure("CDP_CONNECTION_ERROR", "Studio closed its CDP connection"));
      }
      this.requests.clear();
    });
  }

  on(method, handler) {
    this.listeners.set(method, handler);
  }

  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw failure("CDP_CONNECTION_ERROR", "Studio CDP is disconnected");
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(failure("CDP_COMMAND_TIMEOUT", `${method} timed out`));
      }, 45000);
      this.requests.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate(expression, sessionId) {
    const reply = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (reply.exceptionDetails) {
      const { exception, text } = reply.exceptionDetails;
      throw failure("PAGE_EVALUATION_ERROR", exception?.description ?? text);
    }
    return reply.result.value;
  }

  async screenshot(clip) {
    const reply = await this.send("Page.captureScreenshot", {
      format: "png", fromSurface: true,
      ...(clip && { clip: { ...clip, scale: 1 }, captureBeyondViewport: true }),
    });
    return Buffer.from(reply.data, "base64");
  }

  async click([x, y]) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
  }

  close() {
    this.socket.close();
  }
}
