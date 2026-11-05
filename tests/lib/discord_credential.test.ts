import { describe, expect, test } from "bun:test";
import { buildEmbed, type NotifyEvent } from "../../f/factory/lib/discord.ts";

const event: NotifyEvent = {
  kind: "credential_expiring",
  instance_name: "local",
  cause: "GitHubのPAT(github_token)の期限が2026-11-20に切れる。",
  next_action: "ローテーションの手順で更新する",
};

describe("buildEmbed credential_expiring", () => {
  test("says that a credential expires soon", () => {
    expect(buildEmbed(event).title).toBe("資格情報の期限が近づいています");
  });

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe(event.cause);
  });

  test("shows the next action as a field", () => {
    expect(buildEmbed(event).fields).toContainEqual({
      name: "次の操作",
      value: "ローテーションの手順で更新する",
    });
  });
});
