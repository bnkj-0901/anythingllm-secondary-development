const bcrypt = require("bcryptjs");
const { v4, validate } = require("uuid");
const { User } = require("../../models/user");
const {
  RecoveryCode,
  PasswordResetToken,
} = require("../../models/passwordRecovery");
const { dummyHashCompare } = require("../helpers/dummyHashCompare");

async function generateRecoveryCodes(tenantId, userId, store) {
  return store.transaction(
    async (tx) => {
      const user = await tx.one(
        'SELECT id,seen_recovery_codes FROM users WHERE id=$1 AND "tenantId"=$2 FOR UPDATE',
        userId,
        tenantId
      );
      if (!user) throw new Error("User not found");
      if (user.seen_recovery_codes) return [];
      const newRecoveryCodes = [];
      const plainTextCodes = [];
      for (let i = 0; i < 4; i++) {
        const code = v4();
        const hashedCode = bcrypt.hashSync(code, 10);
        newRecoveryCodes.push({
          user_id: userId,
          code_hash: hashedCode,
        });
        plainTextCodes.push(code);
      }

      const { error } = await RecoveryCode.createMany(newRecoveryCodes, tx.orm);
      if (!!error) throw new Error(error);

      await tx.orm.users.update({
        where: { id: userId },
        data: { seen_recovery_codes: true },
      });

      return plainTextCodes;
    },
    { retry: true }
  );
}

async function recoverAccount(
  tenantId,
  username = "",
  recoveryCodes = [],
  store
) {
  const uniqueRecoveryCodes = [
    ...new Set(
      (Array.isArray(recoveryCodes) ? recoveryCodes : [])
        .map((code) => (typeof code === "string" ? code.trim() : ""))
        .filter((code) => validate(code))
    ),
  ].slice(0, 2);
  if (uniqueRecoveryCodes.length !== 2)
    return { success: false, error: "Invalid recovery codes." };

  return store.transaction(async (tx) => {
    // A user without 4 hashes has not logged out and back in since recovery codes were added.
    // Unknown users and users without codes run the same 4 comparisons a wrong first code costs
    // a real user, so the response time does not reveal whether the username exists.
    const user = await tx.one(
      'SELECT * FROM users WHERE "tenantId"=$1 AND username=$2 FOR UPDATE',
      tenantId,
      String(username)
    );
    const allUserHashes =
      user && user.status === "active"
        ? await RecoveryCode.hashesForUser(user.id, tx.orm)
        : [];
    if (allUserHashes.length < 4) {
      dummyHashCompare(uniqueRecoveryCodes[0], 4);
      return { success: false, error: "Invalid recovery codes." };
    }

    const unmatchedHashes = [...allUserHashes];
    const validCodes = uniqueRecoveryCodes.every((code) => {
      const index = unmatchedHashes.findIndex((hash) =>
        bcrypt.compareSync(code, hash)
      );
      if (index === -1) return false;
      unmatchedHashes.splice(index, 1);
      return true;
    });
    if (!validCodes)
      return { success: false, error: "Invalid recovery codes." };

    const { passwordResetToken, error } = await PasswordResetToken.create(
      user.id,
      tx.orm
    );
    if (!!error) return { success: false, error };
    return { success: true, resetToken: passwordResetToken.token };
  });
}

async function resetPassword(
  tenantId,
  token,
  _newPassword = "",
  confirmPassword = "",
  store
) {
  if (typeof _newPassword !== "string" || typeof confirmPassword !== "string")
    throw Object.assign(new Error("Invalid password."), { status: 400 });
  const newPassword = String(_newPassword).trim(); // No spaces in passwords
  if (!newPassword)
    throw Object.assign(new Error("Invalid password."), { status: 400 });
  if (newPassword !== String(confirmPassword))
    throw Object.assign(new Error("Passwords do not match"), { status: 400 });

  return store.transaction(async (tx) => {
    const resetToken = await PasswordResetToken.findUnique(
      {
        token: String(token),
      },
      tx.orm
    );
    if (!resetToken || resetToken.expiresAt < new Date()) {
      return { success: false, message: "Invalid reset token" };
    }

    const user = await tx.one(
      'SELECT * FROM users WHERE "tenantId"=$1 AND id=$2 FOR UPDATE',
      tenantId,
      resetToken.user_id
    );
    if (!user || user.status !== "active")
      return { success: false, message: "Invalid reset token" };

    // JOI password rules will be enforced inside .update.
    await User.updateProfile(
      tenantId,
      resetToken.user_id,
      {
        password: newPassword,
      },
      tx
    );

    // seen_recovery_codes is not publicly writable
    // so we have to do direct update here
    await tx.orm.users.update({
      where: { id: resetToken.user_id },
      data: { seen_recovery_codes: false },
    });

    if (
      !(await PasswordResetToken.deleteMany(
        { user_id: resetToken.user_id },
        tx.orm
      ))
    )
      throw new Error("Failed to remove reset tokens");
    if (
      !(await RecoveryCode.deleteMany({ user_id: resetToken.user_id }, tx.orm))
    )
      throw new Error("Failed to remove recovery codes");

    // New codes are provided on first new login.
    return { success: true, message: "Password reset successful" };
  });
}

module.exports = {
  recoverAccount,
  resetPassword,
  generateRecoveryCodes,
};
