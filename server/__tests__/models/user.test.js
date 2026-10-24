jest.mock("../../enterprise/store", () => ({}));

const { User } = require("../../models/user");
const {
  context,
  refreshContext,
  assertTenantAdmin,
} = require("../../enterprise/auth");

const tenantId = "56169512-2359-4a5d-a506-afab3c7b8beb";
const otherTenantId = "1969df72-7c13-45fe-94b2-aa342fdbd7e6";
const userId = 1;
const stamp = "2026-10-22T00:00:00.000Z";

function account(overrides = {}) {
  return {
    id: userId,
    tenantId,
    username: "admin",
    name: "Company administrator",
    role: "admin",
    status: "active",
    authVersion: 3,
    tenantCode: "company-a",
    tenantName: "Company A",
    tenantStatus: "active",
    ...overrides,
  };
}

function database() {
  return {
    one: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
  };
}

describe("tenant user model", () => {
  let db;
  beforeEach(() => {
    db = database();
  });

  it("preserves daily quotas and counts only the account's chats in the past 24 hours", async () => {
    const orm = { chats: { count: jest.fn().mockResolvedValue(3) } };
    const user = account({ role: "user", dailyMessageLimit: 3 });
    expect(await User.canSendChat(user, orm)).toBe(false);
    expect(orm.chats.count).toHaveBeenCalledWith({
      where: { tenantId, userId, createdAt: { gte: expect.any(Date) } },
    });
    orm.chats.count.mockResolvedValue(2);
    expect(await User.canSendChat(user, orm)).toBe(true);
    expect(await User.canSendChat({ ...user, role: "admin" }, orm)).toBe(true);
    expect(
      await User.canSendChat({ ...user, dailyMessageLimit: null }, orm)
    ).toBe(true);
    expect(() => User.validations.dailyMessageLimit(0)).toThrow();
    expect(() => User.validations.dailyMessageLimit(1.5)).toThrow();
    expect(User.validations.dailyMessageLimit("4")).toBe(4);
  });

  it("looks up the same username separately within each tenant", async () => {
    const first = { id: userId, passwordHash: "first-hash" };
    const second = { id: 2, passwordHash: "second-hash" };
    db.one.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    expect(await User.forLogin(tenantId, "admin", db)).toBe(first);
    expect(await User.forLogin(otherTenantId, "admin", db)).toBe(second);
    expect(db.one.mock.calls[0]).toEqual([
      expect.stringMatching(/WHERE "tenantId"=\$1 AND username=\$2/),
      tenantId,
      "admin",
    ]);
    expect(db.one.mock.calls[1].slice(1)).toEqual([otherTenantId, "admin"]);
  });

  it("binds a username as data rather than interpolating it into login SQL", async () => {
    const username = "admin' OR TRUE --";
    db.one.mockResolvedValue(null);
    expect(await User.forLogin(tenantId, username, db)).toBeNull();
    const [sql, ...params] = db.one.mock.calls[0];
    expect(sql).not.toContain(username);
    expect(params).toEqual([tenantId, username]);
  });

  it("keeps integer identities intact while loading their owning tenant", async () => {
    const user = account();
    db.one.mockResolvedValue(user);
    expect(await User.authenticationContext(userId, db)).toBe(user);
    expect(db.one).toHaveBeenCalledWith(
      expect.stringMatching(
        /JOIN ep_tenants t ON t.id=u\."tenantId" WHERE u.id=\$1/
      ),
      userId
    );
  });

  it("requires both tenant and user identifiers when loading an account", async () => {
    db.one.mockResolvedValue(null);
    expect(await User.get(otherTenantId, userId, db)).toBeNull();
    expect(db.one).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE "tenantId"=\$1 AND id=\$2/),
      otherTenantId,
      userId
    );
  });

  it("lists only the selected tenant without returning password hashes", async () => {
    const rows = [{ id: userId, username: "admin", role: "admin" }];
    db.all.mockResolvedValue(rows);
    expect(await User.list(tenantId, db)).toBe(rows);
    const [sql, ...params] = db.all.mock.calls[0];
    expect(sql).toMatch(/WHERE "tenantId"=\$1/);
    expect(sql).not.toMatch(/passwordHash|SELECT \*/);
    expect(params).toEqual([tenantId]);
  });

  it.each(["admin", "user"])(
    "creates a %s account with explicit ownership and a precomputed password hash",
    async (role) => {
      db.one.mockResolvedValue({ id: userId });
      expect(
        await User.create(
          {
            id: userId,
            tenantId,
            username: "admin",
            name: "Company user",
            passwordHash: "precomputed-hash",
            role,
            createdAt: stamp,
          },
          db
        )
      ).toEqual({ id: userId });
      expect(db.one.mock.calls[0].slice(1)).toEqual([
        tenantId,
        "admin",
        "Company user",
        "precomputed-hash",
        role,
        stamp,
        null,
      ]);
      expect(db.one.mock.calls[0][0]).toMatch(/INSERT INTO users\("tenantId"/);
    }
  );

  it("updates only the owning tenant and cannot move an account to another company", async () => {
    db.run.mockResolvedValue(1);
    expect(
      await User.update(
        tenantId,
        userId,
        {
          tenantId: otherTenantId,
          name: "Edited user",
          role: "user",
          status: "disabled",
          passwordHash: "replacement-hash",
          authVersion: 4,
          updatedAt: stamp,
        },
        db
      )
    ).toBe(1);
    const [sql, ...params] = db.run.mock.calls[0];
    const [assignments] = sql.split(" WHERE ");
    expect(assignments).not.toContain('"tenantId"=');
    expect(sql).toMatch(/WHERE id=\$7 AND "tenantId"=\$8$/);
    expect(params).toEqual([
      "Edited user",
      "user",
      "disabled",
      "replacement-hash",
      4,
      stamp,
      userId,
      tenantId,
      false,
      null,
    ]);
    expect(params).not.toContain(otherTenantId);
  });
});

describe("preserved upstream account validation", () => {
  it("normalizes display names while rejecting empty or overlong values", () => {
    expect(User.validations.name("  微信昵称  ")).toBe("微信昵称");
    expect(User.validations.name("a".repeat(80))).toHaveLength(80);
    for (const value of ["", "   ", null, 42, "a".repeat(81)])
      expect(() => User.validations.name(value)).toThrow();
  });
  it.each(["a", "_invalid", "9starts-with-digit", "bad name", "a".repeat(65)])(
    "rejects invalid usernames %s",
    (value) => {
      expect(() => User.validations.username(value)).toThrow();
    }
  );
  it.each(["ab", "alice@example.com", "valid-user_2"])(
    "preserves accepted original username %s",
    (value) => {
      expect(User.validations.username(value)).toBe(value);
    }
  );
  it("preserves biography limits and filters both old and current credential columns", () => {
    expect(User.validations.bio("")).toBe("");
    expect(User.validations.bio("original profile")).toBe("original profile");
    expect(() => User.validations.bio("a".repeat(1001))).toThrow();
    expect(
      User.filterFields({
        id: userId,
        password: "old",
        passwordHash: "new",
        web_push_subscription_config: "private",
        wechatIdentity: "appid:private-openid",
        bio: "profile",
      })
    ).toEqual({ id: userId, bio: "profile" });
  });
  it("keeps the original minimum and configurable password complexity", () => {
    expect(User.checkPasswordComplexity("12345678").checkedOK).toBe(true);
    expect(User.checkPasswordComplexity("short").checkedOK).toBe(false);
    const old = process.env.PASSWORDUPPERCASE;
    process.env.PASSWORDUPPERCASE = "1";
    try {
      expect(User.checkPasswordComplexity("lowercase-only").checkedOK).toBe(
        false
      );
      expect(User.checkPasswordComplexity("HasUppercase").checkedOK).toBe(true);
    } finally {
      if (old === undefined) delete process.env.PASSWORDUPPERCASE;
      else process.env.PASSWORDUPPERCASE = old;
    }
  });
});

describe("tenant user authentication contract", () => {
  let db;
  beforeEach(() => {
    db = database();
  });

  it.each(["admin", "user"])(
    "authenticates an active %s with exactly one enterprise identity",
    async (role) => {
      db.one.mockResolvedValue(account({ role }));
      expect(await context(userId, db)).toMatchObject({
        identity: "tenant",
        userId,
        tenantId,
        role,
        user: { id: userId, username: "admin" },
        tenant: { id: tenantId, code: "company-a", name: "Company A" },
      });
    }
  );

  it.each([
    ["missing account", null],
    ["disabled account", account({ status: "disabled" })],
    ["disabled tenant", account({ tenantStatus: "disabled" })],
    ["platform role in tenant account", account({ role: "platform_admin" })],
    ["unknown role", account({ role: "manager" })],
  ])("rejects a %s", async (_label, user) => {
    db.one.mockResolvedValue(user);
    await expect(context(userId, db)).rejects.toMatchObject({ status: 401 });
  });

  it("refreshes an unchanged account while retaining its integer identity", async () => {
    db.one.mockResolvedValue(account());
    expect(
      await refreshContext(
        { identity: "tenant", userId, tenantId, authVersion: 3 },
        db
      )
    ).toMatchObject({ userId, tenantId, authVersion: 3 });
  });

  it.each([
    ["different enterprise", { tenantId: otherTenantId, authVersion: 3 }],
    ["revoked session", { tenantId, authVersion: 2 }],
  ])("rejects a session for a %s", async (_label, claims) => {
    db.one.mockResolvedValue(account());
    await expect(
      refreshContext({ identity: "tenant", userId, ...claims }, db)
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an absent identity before loading any account", async () => {
    await expect(refreshContext(null, db)).rejects.toMatchObject({
      status: 401,
    });
    expect(db.one).not.toHaveBeenCalled();
  });

  it("refreshes a platform account from its own table without loading an enterprise account", async () => {
    db.one.mockResolvedValueOnce(null);
    await expect(
      refreshContext({ identity: "platform", userId, tenantId }, db)
    ).rejects.toMatchObject({ status: 401 });
    expect(db.one).toHaveBeenCalledWith(
      expect.stringContaining("FROM ep_platform_accounts WHERE id=$1"),
      userId
    );
    expect(
      db.one.mock.calls.every(([sql]) => !sql.includes("FROM users"))
    ).toBe(true);
    db.one.mockResolvedValueOnce({
      id: userId,
      username: "top",
      name: "Top administrator",
      status: "active",
      authVersion: 3,
    });
    expect(
      await refreshContext({ identity: "platform", userId, authVersion: 3 }, db)
    ).toMatchObject({
      identity: "platform",
      userId,
      role: "platform_admin",
      tenant: null,
    });
  });

  it("checks the current role rather than a stale administrator claim", async () => {
    db.one.mockResolvedValue(account({ role: "user" }));
    await expect(
      assertTenantAdmin(
        { identity: "tenant", userId, tenantId, authVersion: 3, role: "admin" },
        db
      )
    ).rejects.toMatchObject({ status: 403 });
    db.one.mockResolvedValue(account());
    expect(
      await assertTenantAdmin(
        { identity: "tenant", userId, tenantId, authVersion: 3 },
        db
      )
    ).toMatchObject({ role: "admin", tenantId });
  });
});
