/* global jest, beforeAll, afterAll, test, expect */
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { initializeDatabase } = require("../../prisma/init");
const { CURRENT_MIGRATION } = require("../../enterprise/store");
let fixture;
beforeAll(async () => {
  fixture = await createPostgresFixture();
});
afterAll(async () => fixture?.cleanup());

test("upgrading existing accounts requires one-time WeChat registration without replacing users", async () => {
  const upgrade = await createPostgresFixture();
  try {
    await upgrade.db.run(
      'ALTER TABLE users DROP COLUMN "wechatRegistrationComplete"'
    );
    await upgrade.db.run(
      "DELETE FROM _prisma_migrations WHERE migration_name=$1",
      "20261023000100_wechat_registration"
    );
    await upgrade.prisma.ep_tenants.create({
      data: {
        id: "upgrade",
        code: "upgrade",
        name: "企业",
        hostname: "upgrade.localhost",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const wechat = await upgrade.db.one(
      'INSERT INTO users("tenantId",username,name,"passwordHash","wechatIdentity") VALUES($1,$2,$3,$4,$5) RETURNING id',
      "upgrade",
      "wx_upgrade",
      "原昵称",
      "unused",
      "wx:isolated-upgrade"
    );
    await upgrade.db.run(
      'INSERT INTO users("tenantId",username,name,"passwordHash") VALUES($1,$2,$3,$4)',
      "upgrade",
      "ordinary",
      "普通用户",
      "unused"
    );
    const { spawnSync } = require("child_process");
    const path = require("path");
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("prisma/build/index.js"),
        "migrate",
        "deploy",
        "--schema",
        path.resolve(__dirname, "../../prisma/schema.prisma"),
      ],
      {
        env: { ...process.env, DATABASE_URL: upgrade.url },
        windowsHide: true,
        encoding: "utf8",
        timeout: 60000,
      }
    );
    expect(result.status).toBe(0);
    expect(
      await upgrade.db.all(
        'SELECT id,username,name,"wechatRegistrationComplete" FROM users ORDER BY id'
      )
    ).toEqual([
      {
        id: wechat.id,
        username: "wx_upgrade",
        name: "原昵称",
        wechatRegistrationComplete: false,
      },
      {
        id: expect.any(Number),
        username: "ordinary",
        name: "普通用户",
        wechatRegistrationComplete: true,
      },
    ]);
  } finally {
    await upgrade.cleanup();
  }
});

test("fresh deployment creates the required V1 product and reused settings tables", async () => {
  const tables = await fixture.db.all(
    "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename <> '_prisma_migrations' ORDER BY tablename",
    fixture.schema
  );
  // Additional upstream capability tables are subject to their ownership review.
  // Their absence is not a V1 requirement.
  expect(tables.map(({ tablename }) => tablename)).toEqual(
    expect.arrayContaining([
      "chat_threads",
      "chats",
      "ep_chunks",
      "ep_connections",
      "ep_documents",
      "ep_file_cleanup",
      "ep_libraries",
      "ep_library_grants",
      "ep_platform_accounts",
      "ep_rag_settings",
      "ep_tenants",
      "ep_vector_cleanup",
      "ep_vector_settings",
      "event_logs",
      "password_reset_tokens",
      "recovery_codes",
      "system_prompt_variables",
      "system_settings",
      "users",
    ])
  );
  expect(
    await fixture.db.all(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
    )
  ).toEqual([
    { migration_name: CURRENT_MIGRATION },
    { migration_name: "20261023000100_wechat_registration" },
  ]);
  const oldIdentityColumns = await fixture.db.all(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('event_logs','system_prompt_variables') AND column_name='userId'",
    fixture.schema
  );
  // Audit actors include both enterprise and top administrator IDs; this is an
  // original capability retained as text, not the retired numeric user FK.
  expect(oldIdentityColumns).toEqual([
    { table_name: "event_logs", column_name: "userId" },
  ]);
  const actorColumn = await fixture.db.one(
    "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='event_logs' AND column_name='userId'",
    fixture.schema
  );
  expect(actorColumn.data_type).toBe("text");
  const defaults = await fixture.db.all("SELECT * FROM ep_vector_settings");
  expect(defaults).toEqual([
    expect.objectContaining({
      id: "platform",
      provider: "lancedb",
      revision: 1,
    }),
  ]);
  for (const table of [
    "ep_tenants",
    "users",
    "ep_platform_accounts",
    "ep_libraries",
    "ep_documents",
    "chat_threads",
  ])
    expect(
      await fixture.db.one(`SELECT COUNT(*) AS count FROM "${table}"`)
    ).toEqual({
      count: 0,
    });
});

test("PostgreSQL baseline preserves tenant account uniqueness and database invariants", async () => {
  const stamp = "2026-10-21T00:00:00.000Z";
  for (const id of ["a", "b"])
    await fixture.db.run(
      'INSERT INTO "ep_tenants" ("id","code","name","hostname","createdAt","updatedAt") VALUES($1,$2,$3,$2 || \'.localhost\',$4,$4)',
      id,
      `company-${id}`,
      id,
      stamp
    );
  for (const tenant of ["a", "b"])
    await fixture.db.run(
      'INSERT INTO "users" ("id","tenantId","username","name","passwordHash","createdAt","lastUpdatedAt") VALUES($1,$2,$3,$3,$4,$5::timestamp,$5::timestamp)',
      tenant === "a" ? 101 : 102,
      tenant,
      "admin",
      "synthetic",
      stamp
    );
  await expect(
    fixture.db.run(
      'INSERT INTO "users" ("id","tenantId","username","name","passwordHash","createdAt","lastUpdatedAt") VALUES($1,$2,$3,$3,$4,$5::timestamp,$5::timestamp)',
      103,
      "a",
      "admin",
      "synthetic",
      stamp
    )
  ).rejects.toMatchObject({ code: "P2010" });
  await expect(
    fixture.db.run(
      'INSERT INTO "ep_tenants" ("id","code","name","hostname","createdAt","updatedAt") VALUES($1,$2,$3,$2 || \'.localhost\',$4,$4)',
      "uppercase",
      "UPPERCASE",
      "upper",
      stamp
    )
  ).rejects.toMatchObject({ code: "P2010" });
  for (const [id, tenant] of [
    ["platform", null],
    ["tenant", "a"],
  ])
    await fixture.db.run(
      'INSERT INTO "ep_connections" ("id","tenantId","scope","kind","provider","name","model","isDefault","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$1,$6,1,$7,$7)',
      id,
      tenant,
      tenant ? "tenant" : "platform",
      "chat",
      "deepseek",
      "deepseek-chat",
      stamp
    );
  await expect(
    fixture.db.run(
      'INSERT INTO "ep_connections" ("id","tenantId","scope","kind","provider","name","model","isDefault","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$1,$6,1,$7,$7)',
      "duplicate-default",
      "a",
      "tenant",
      "chat",
      "deepseek",
      "deepseek-chat",
      stamp
    )
  ).rejects.toMatchObject({ code: "P2010" });
  await expect(
    fixture.db.run(
      "UPDATE ep_tenants SET hostname=$1 WHERE id=$2",
      "upper.EXAMPLE",
      "a"
    )
  ).rejects.toMatchObject({ code: "P2010" });
  await expect(
    fixture.db.run(
      "UPDATE ep_tenants SET hostname=$1 WHERE id=$2",
      "company-a.localhost",
      "b"
    )
  ).rejects.toMatchObject({ code: "P2010" });
  await expect(
    fixture.db.run('UPDATE users SET "tenantId"=$1 WHERE id=$2', "b", 101)
  ).rejects.toMatchObject({ code: "P2010" });
});
test("origin integrity and personal conversation ownership remain enforced independently of library grants", async () => {
  const db = fixture.db;
  const stamp = "2026-10-22T00:00:00.000Z";
  const rejected = (query) =>
    expect(query).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23503" },
    });
  await rejected(
    db.run(
      'INSERT INTO chat_threads(id,"tenantId","userId",name,slug,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$1::text,$1::text,$4::timestamp,$4::timestamp)',
      201,
      "a",
      102,
      stamp
    )
  );
  for (const tenantId of ["a", "b"])
    await db.run(
      'INSERT INTO ep_libraries(id,"tenantId",name,"createdBy","createdAt","updatedAt") VALUES($1,$2,$1,$3,$4,$4)',
      `library-${tenantId}`,
      tenantId,
      tenantId === "a" ? "101" : "102",
      stamp
    );
  await rejected(
    db.run(
      'INSERT INTO ep_documents(id,"tenantId","libraryId",title,"inputType",status,"createdBy","updatedBy","createdAt","updatedAt") VALUES($1,$2,$3,$1,\'text\',\'ready\',$4,$4,$5,$5)',
      "cross-document",
      "b",
      "library-a",
      "102",
      stamp
    )
  );
  await db.run(
    'INSERT INTO ep_documents(id,"tenantId","libraryId",title,"inputType",status,"createdBy","updatedBy","createdAt","updatedAt") VALUES($1,$2,$3,$1,\'text\',\'ready\',$4,$4,$5,$5)',
    "document-a",
    "a",
    "library-a",
    "101",
    stamp
  );
  await rejected(
    db.run(
      "INSERT INTO ep_chunks(id,\"tenantId\",\"documentId\",version,position,content,\"embeddingId\",dimensions,namespace) VALUES($1,$2,$3,1,0,'source','embed',3,'test')",
      "cross-chunk",
      "b",
      "document-a"
    )
  );
  await db.run(
    'INSERT INTO chat_threads(id,"tenantId","userId",name,slug,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$1::text,$1::text,$4::timestamp,$4::timestamp)',
    202,
    "a",
    101,
    stamp
  );
  await rejected(
    db.run(
      'INSERT INTO chats(id,"tenantId","userId",thread_id,prompt,response,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,\'question\',\'{"text":"answer"}\',$5::timestamp,$5::timestamp)',
      301,
      "b",
      102,
      202,
      stamp
    )
  );
  await db.run(
    'INSERT INTO chats(id,"tenantId","userId",thread_id,prompt,response,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,\'question\',\'{"text":"answer"}\',$5::timestamp,$5::timestamp)',
    302,
    "a",
    101,
    202,
    stamp
  );
  expect(await db.one("SELECT id,include FROM chats WHERE id=302")).toEqual({
    id: 302,
    include: true,
  });
});

test("fresh baseline includes every custom invariant, default uniqueness and immutable user ownership", async () => {
  const checks = await fixture.db.all(
    "SELECT conname FROM pg_constraint WHERE connamespace=$1::regnamespace AND contype='c' ORDER BY conname",
    fixture.schema
  );
  expect(checks.map(({ conname }) => conname)).toEqual([
    "ep_chunks_dimensions_check",
    "ep_connections_flags_check",
    "ep_connections_kind_check",
    "ep_connections_scope_check",
    "ep_library_grants_subject_check",
    "ep_platform_accounts_auth_version_check",
    "ep_platform_accounts_status_check",
    "ep_platform_accounts_username_normalized",
    "ep_tenants_code_normalized",
    "ep_tenants_hostname_normalized",
    "ep_tenants_status_check",
    "ep_vector_settings_singleton_check",
    "users_auth_version_check",
    "users_role_check",
    "users_status_check",
    "users_username_normalized",
  ]);
  const index = await fixture.db.one(
    "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='ep_connection_default'",
    fixture.schema
  );
  expect(index.indexdef).toMatch(/CREATE UNIQUE INDEX.*COALESCE/);
  expect(index.indexdef).toMatch(/WHERE.*isDefault.*= 1/);
  expect(
    await fixture.db.one(
      "SELECT COUNT(*) AS count FROM pg_trigger WHERE tgname='users_tenant_immutable' AND tgrelid=$1::regclass AND NOT tgisinternal",
      `${fixture.schema}.users`
    )
  ).toEqual({ count: 1 });
  // The trigger allows ordinary account maintenance but forbids reassignment.
  expect(
    await fixture.db.run(
      'UPDATE users SET "tenantId"=$1,name=$2 WHERE id=$3',
      "a",
      "Updated name",
      101
    )
  ).toBe(1);
  await expect(
    fixture.db.run('UPDATE users SET "tenantId"=$1 WHERE id=$2', "b", 101)
  ).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
});

test("library grants select a tenant or an individual independently of the resource origin", async () => {
  const orm = fixture.prisma;
  await orm.ep_library_grants.create({
    data: { id: "share-a", libraryId: "library-a", tenantId: "a" },
  });
  await orm.ep_library_grants.create({
    data: { id: "share-b", libraryId: "library-a", tenantId: "b" },
  });
  await orm.ep_library_grants.create({
    data: { id: "share-user", libraryId: "library-a", userId: 102 },
  });
  expect(
    await orm.ep_library_grants.count({ where: { libraryId: "library-a" } })
  ).toBe(3);
  for (const [id, tenantId, userId] of [
    ["missing-subject", null, null],
    ["double-subject", "a", 101],
  ])
    await expect(
      fixture.db.run(
        'INSERT INTO ep_library_grants(id,"libraryId","tenantId","userId") VALUES($1,$2,$3,$4)',
        id,
        "library-a",
        tenantId,
        userId
      )
    ).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
  await expect(
    orm.ep_library_grants.create({
      data: { id: "duplicate-share", libraryId: "library-a", tenantId: "b" },
    })
  ).rejects.toMatchObject({ code: "P2002" });
  expect((await orm.users.findUnique({ where: { id: 102 } })).tenantId).toBe(
    "b"
  );
});

test("repeated deployment initialization preserves configured data without seeding retired business records", async () => {
  await fixture.prisma.system_settings.create({
    data: { label: "deployment_replay_check", value: "preserve" },
  });
  const before = await fixture.db.all("SELECT * FROM ep_vector_settings");
  expect(
    await initializeDatabase({
      environment: {
        ...process.env,
        DATABASE_URL: fixture.url,
        INITIAL_ADMIN_USERNAME: "initial-admin",
        INITIAL_ADMIN_PASSWORD: "test-bootstrap-password",
      },
    })
  ).toBe(true);
  expect(await fixture.db.all("SELECT * FROM ep_vector_settings")).toEqual(
    before
  );
  expect(
    await fixture.prisma.system_settings.findMany({
      select: { label: true, value: true },
    })
  ).toEqual([{ label: "deployment_replay_check", value: "preserve" }]);
  expect(
    await fixture.db.one("SELECT COUNT(*) AS count FROM ep_platform_accounts")
  ).toEqual({ count: 1 });
  expect(
    await fixture.db.all(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename IN ('workspaces','workspace_users')",
      fixture.schema
    )
  ).toEqual([]);
});

test("explicit initializer deploys only the PostgreSQL versioned schema and reports failure", async () => {
  const log = jest.spyOn(console, "log").mockImplementation(() => {}),
    error = jest.spyOn(console, "error").mockImplementation(() => {});
  const previous = process.exitCode;
  try {
    const success = jest.fn(() => ({ status: 0 }));
    expect(
      await initializeDatabase({
        run: success,
        read: () => "",
        prisma: {},
        bootstrap: async () => ({ created: false }),
        environment: { DATABASE_URL: "postgresql://synthetic@localhost/test" },
      })
    ).toBe(true);
    expect(success.mock.calls[0][1].slice(1, 3)).toEqual(["migrate", "deploy"]);
    expect(success.mock.calls[0][1].at(-1)).toMatch(
      /[\\/]prisma[\\/]schema.prisma$/
    );
    expect(
      await initializeDatabase({
        run: () => ({ status: 2 }),
        environment: { DATABASE_URL: "postgresql://synthetic@localhost/test" },
      })
    ).toBe(false);
    expect(process.exitCode).toBe(2);
    expect(
      await initializeDatabase({
        run: () => ({ error: new Error("synthetic spawn failure") }),
        environment: { DATABASE_URL: "postgresql://synthetic@localhost/test" },
      })
    ).toBe(false);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
    log.mockRestore();
    error.mockRestore();
  }
});
