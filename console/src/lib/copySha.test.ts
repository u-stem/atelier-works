import { describe, expect, test } from "bun:test";
import { copySha } from "./copySha.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function recorder(): {
  messages: string[];
  notify: { success: (m: string) => void; error: (m: string) => void };
} {
  const messages: string[] = [];
  return {
    messages,
    notify: {
      success: (message) => {
        messages.push(`success:${message}`);
      },
      error: (message) => {
        messages.push(`error:${message}`);
      },
    },
  };
}

describe("copySha", () => {
  test("writes the full version to the clipboard", async () => {
    const written: string[] = [];
    await copySha(
      SHA,
      {
        writeText: async (text) => {
          written.push(text);
        },
      },
      recorder().notify,
    );
    expect(written).toEqual([SHA]);
  });

  test("reports success when the clipboard accepts the text", async () => {
    const { messages, notify } = recorder();
    await copySha(SHA, { writeText: async () => {} }, notify);
    expect(messages).toEqual(["success:版を複製しました"]);
  });

  test("reports failure when the clipboard rejects the text", async () => {
    const { messages, notify } = recorder();
    await copySha(
      SHA,
      {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      notify,
    );
    expect(messages).toEqual(["error:版を複製できませんでした"]);
  });

  test("reports failure when there is no clipboard", async () => {
    const { messages, notify } = recorder();
    await copySha(SHA, undefined, notify);
    expect(messages).toEqual(["error:この環境では複製できません"]);
  });
});
