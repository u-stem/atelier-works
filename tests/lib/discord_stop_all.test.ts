import { describe, expect, test } from "bun:test";
import { buildEmbed, type NotifyEvent } from "../../f/factory/lib/discord.ts";

const event: NotifyEvent = {
  kind: "stop_all_active",
  instance_name: "local",
  cause: "2026-11-05 12:00 JSTにoperatorが全停止を置きました。理由: r",
  next_action: "解除する",
};

describe("buildEmbed stop_all_active", () => {
  test("says that the Factory is stopped", () => {
    expect(buildEmbed(event).title).toBe("Factoryを全停止しています");
  });

  test("puts the cause in the description", () => {
    expect(buildEmbed(event).description).toBe(event.cause);
  });
});
