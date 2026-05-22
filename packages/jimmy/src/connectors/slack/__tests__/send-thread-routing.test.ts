import { describe, it, expect } from "vitest";
import { SlackConnector } from "../index.js";
import type { Target } from "../../../shared/types.js";

/**
 * Regression tests for the customer-reply / thread-routing bug.
 *
 * Bug: a customer-facing reply was posted bare to the channel root instead of
 * inside the originating thread, because `sendMessage` ignored `target.thread`.
 *
 * Fix: `sendMessage` now honours `target.thread` when one is supplied, and
 * `replyMessage` continues to thread under `target.thread || target.messageTs`.
 */

interface PostedMessage {
  channel: string;
  thread_ts?: string;
  text: string;
}

/**
 * Build a SlackConnector with its Slack client stubbed so we can capture
 * outgoing chat.postMessage calls without touching the network.
 */
function makeConnector(): { connector: SlackConnector; posted: PostedMessage[] } {
  const posted: PostedMessage[] = [];
  const connector = new SlackConnector({
    botToken: "xoxb-test",
    appToken: "xapp-test",
  } as any);

  // Replace the bolt App's client with a minimal stub.
  (connector as any).app = {
    client: {
      chat: {
        postMessage: async (args: PostedMessage) => {
          posted.push(args);
          return { ts: `${1700000000 + posted.length}.000000` };
        },
      },
    },
  };

  return { connector, posted };
}

describe("SlackConnector thread routing", () => {
  it("replyMessage threads the reply under target.thread", async () => {
    const { connector, posted } = makeConnector();
    const target: Target = {
      channel: "C123",
      thread: "1700000000.000100",
      messageTs: "1700000050.000200",
    };

    await connector.replyMessage(target, "小林さん、ご相談ありがとうございます");

    expect(posted).toHaveLength(1);
    expect(posted[0].channel).toBe("C123");
    expect(posted[0].thread_ts).toBe("1700000000.000100");
  });

  it("replyMessage falls back to messageTs when no thread is set", async () => {
    const { connector, posted } = makeConnector();
    const target: Target = {
      channel: "C123",
      messageTs: "1700000050.000200",
    };

    await connector.replyMessage(target, "返信本文");

    expect(posted[0].thread_ts).toBe("1700000050.000200");
  });

  it("sendMessage honours target.thread instead of posting to channel root", async () => {
    const { connector, posted } = makeConnector();
    const target: Target = {
      channel: "C123",
      thread: "1700000000.000100",
    };

    await connector.sendMessage(target, "顧客向けの返信");

    expect(posted).toHaveLength(1);
    // The core regression: this must NOT be a bare channel post.
    expect(posted[0].thread_ts).toBe("1700000000.000100");
  });

  it("sendMessage posts to channel root when no thread is supplied", async () => {
    const { connector, posted } = makeConnector();
    const target: Target = { channel: "C123" };

    await connector.sendMessage(target, "本当のルート投稿");

    expect(posted).toHaveLength(1);
    expect(posted[0].thread_ts).toBeUndefined();
  });
});
