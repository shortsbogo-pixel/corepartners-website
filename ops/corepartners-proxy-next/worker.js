const ORIGIN = "4f4c6846-corepartners.shortsbogo.workers.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;

    const originUrl = new URL(url);
    originUrl.protocol = "https:";
    originUrl.hostname = ORIGIN;
    originUrl.port = "";

    const originReq = new Request(originUrl.toString(), request);
    originReq.headers.set("X-Forwarded-Host", host);
    originReq.headers.set("X-Forwarded-Proto", "https");

    const res = await fetch(originReq, { redirect: "manual" });
    const headers = new Headers(res.headers);

    for (const key of ["Location", "Content-Security-Policy", "Link"]) {
      const v = headers.get(key);
      if (v) headers.set(key, v.split(ORIGIN).join(host));
    }

    if (res.status === 204 || res.status === 304 || res.status === 101) {
      return new Response(null, { status: res.status, headers });
    }

    const type = headers.get("Content-Type") || "";
    if (!/text\/html|text\/css|javascript|json|xml/i.test(type)) {
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    }

    const body = (await res.text()).split(ORIGIN).join(host);
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");

    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  },
};
