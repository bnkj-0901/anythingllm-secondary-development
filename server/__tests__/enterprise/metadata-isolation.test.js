const { MetaGenerator } = require("../../utils/boot/MetaGenerator");

function renderer(title, favicon) {
  return new MetaGenerator({
    settings: {
      getValueOrFallback: async ({ label }, fallback) =>
        ({ meta_page_title: title, meta_page_favicon: favicon })[label] ??
        fallback,
    },
  });
}

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
}

test("concurrent tenant pages and manifests keep the upstream metadata renderer without sharing configuration", async () => {
  const a = renderer("企业 A", "https://a.example/favicon.png");
  const b = renderer("企业 B", "https://b.example/favicon.png");
  const ar = response(),
    br = response(),
    am = response(),
    bm = response();
  await Promise.all([
    a.generate(ar),
    b.generate(br),
    a.generateManifest(am),
    b.generateManifest(bm),
  ]);
  expect(ar.send.mock.calls[0][0]).toContain("企业 A");
  expect(ar.send.mock.calls[0][0]).not.toContain("企业 B");
  expect(br.send.mock.calls[0][0]).toContain("https://b.example/favicon.png");
  expect(br.send.mock.calls[0][0]).not.toContain("a.example");
  expect(am.send.mock.calls[0][0].name).toBe("企业 A");
  expect(bm.send.mock.calls[0][0].name).toBe("企业 B");
});

test("tenant titles retain the original HTML escaping and scoped readers do not replace the original singleton", async () => {
  const original = new MetaGenerator();
  const scoped = renderer(
    '<script>alert("title")</script>',
    "https://tenant.example/icon.png"
  );
  const res = response();
  await scoped.generate(res);
  expect(res.send.mock.calls[0][0]).toContain("&lt;script&gt;");
  expect(res.send.mock.calls[0][0]).not.toContain('<script>alert("title")');
  expect(new MetaGenerator()).toBe(original);
  expect(scoped).not.toBe(original);
});
