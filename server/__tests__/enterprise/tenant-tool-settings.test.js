const { createPostgresFixture } = require("./postgres-fixture.cjs");
let mockFixture;
jest.mock("../../utils/prisma", () => new Proxy({}, {get:(_target,key) => {
  const value = mockFixture.prisma[key];
  return typeof value === "function" ? value.bind(mockFixture.prisma) : value;
}}));
const { SystemSettings } = require("../../models/systemSettings");
beforeAll(async()=>{mockFixture=await createPostgresFixture();});
afterAll(async()=>mockFixture?.cleanup());

test("enterprise credentials never fall back to another company or a legacy global credential",async()=>{
  await mockFixture.prisma.system_settings.create({data:{label:"gmail_agent_config",value:JSON.stringify({apiKey:"legacy-global"})}});
  expect(await SystemSettings.withTenantConfiguration("new-company",()=>SystemSettings.get({label:"gmail_agent_config"}))).toBeNull();
  for (const tenant of ["company-a","company-b"])
    await SystemSettings.withTenantConfiguration(tenant,()=>SystemSettings.updateSettings({gmail_agent_config:JSON.stringify({deploymentId:tenant,apiKey:`key-${tenant}`})}));
  const results=await Promise.all(["company-a","company-b"].map(tenant=>SystemSettings.withTenantConfiguration(tenant,async()=>{
    await new Promise(resolve=>setImmediate(resolve));
    return JSON.parse((await SystemSettings.get({label:"gmail_agent_config"})).value);
  })));
  expect(results).toEqual([{deploymentId:"company-a",apiKey:"key-company-a"},{deploymentId:"company-b",apiKey:"key-company-b"}]);
  await SystemSettings.withTenantConfiguration("company-a",()=>SystemSettings.delete({label:"gmail_agent_config"}));
  expect(await SystemSettings.withTenantConfiguration("company-a",()=>SystemSettings.get({label:"gmail_agent_config"}))).toBeNull();
  expect(JSON.parse((await SystemSettings.withTenantConfiguration("company-b",()=>SystemSettings.get({label:"gmail_agent_config"}))).value).apiKey).toBe("key-company-b");
});

test("original bridge instances cache credentials within their own enterprise",async()=>{
  class Bridge { #key; async read(){ if (!this.#key) this.#key=JSON.parse((await SystemSettings.get({label:"gmail_agent_config"})).value).apiKey;return this.#key;} }
  const bridge=SystemSettings.tenantBridge(Bridge);
  bridge.staticHelper="original helper";
  await SystemSettings.withTenantConfiguration("company-a",()=>SystemSettings.updateSettings({gmail_agent_config:JSON.stringify({apiKey:"new-key-a"})}));
  expect(await SystemSettings.withTenantConfiguration("company-a",()=>bridge.read())).toBe("new-key-a");
  expect(await SystemSettings.withTenantConfiguration("company-b",()=>bridge.read())).toBe("key-company-b");
  expect(bridge.staticHelper).toBe("original helper");
});
