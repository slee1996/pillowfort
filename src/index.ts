export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export { Room } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room");
      if (!roomId || roomId.length > 10) {
        console.log(`[ws] rejected — invalid room param: ${roomId}`);
        return new Response("invalid room", { status: 400 });
      }
      console.log(`[ws] routing to room ${roomId}`);
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
