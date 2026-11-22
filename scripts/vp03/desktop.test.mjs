import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gateStudio } from "./desktop.mjs";

test("the first document can instrument the runtime while Studio's entry is held", async () => {
  const requests = [];
  const upstream = createServer((req, res) => {
    requests.push(req.url);
    res.end(req.url);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = await gateStudio(new URL("http://127.0.0.1:0"), new URL(`http://127.0.0.1:${upstream.address().port}`));
  try {
    const get = path => fetch(new URL(path, gate.origin), { signal: AbortSignal.timeout(5_000) }).then(reply => reply.text());
    assert.equal(await get("/"), "/");
    const entry = get("/src/main.tsx");
    const runtime = get("/forge3d-web/index.js");
    gate.startRuntime();
    assert.equal(await runtime, "/forge3d-web/index.js");
    assert.equal(await get("/forge3d-web/dependency.js"), "/forge3d-web/dependency.js");
    assert.deepEqual(requests, ["/", "/forge3d-web/index.js", "/forge3d-web/dependency.js"]);
    gate.start();
    assert.equal(await entry, "/src/main.tsx");
  } finally {
    await gate.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("a reset on either side of an upgraded connection closes the tunnel and the gate keeps serving", {timeout:10_000}, async () => {
  const upstream = createServer((req,res) => res.end("ready"));
  upstream.on("upgrade", (_req, socket) => {
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.resume();
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = await gateStudio(new URL("http://127.0.0.1:0"), new URL(`http://127.0.0.1:${upstream.address().port}`));
  try {
    for (const side of ["client","upstream"]) {
      const upgraded = once(upstream, "upgrade");
      const client = connect(Number(gate.origin.port), "127.0.0.1");
      client.on("error", () => {});
      const reply = once(client, "data");
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      const [, peer] = await upgraded;
      try {
        assert.match(String((await reply)[0]), /101 Switching Protocols/);
        const closed = [client,peer].map(socket => new Promise(resolve => socket.once("close", resolve)));
        (side === "client" ? client : peer).resetAndDestroy();
        await Promise.race([
          Promise.all(closed),
          delay(3000, undefined, {ref:false}).then(() => { throw Error(side + " reset left the tunnel open"); }),
        ]);
        assert.equal(await (await fetch(gate.origin)).text(), "ready");
      } finally {
        client.destroy();
        peer.destroy();
      }
    }
  } finally {
    await gate.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
