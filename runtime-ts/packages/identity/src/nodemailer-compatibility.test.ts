import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

async function startFakeSmtp() {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const messages: string[] = [];
  const errors: Error[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => errors.push(error));
    let pending = "";
    let messageLines: string[] | undefined;
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf("\r\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (messageLines !== undefined) {
          if (line === ".") {
            messages.push(messageLines.join("\r\n"));
            messageLines = undefined;
            socket.write("250 2.0.0 accepted\r\n");
          } else {
            messageLines.push(line.startsWith("..") ? line.slice(1) : line);
          }
        } else {
          commands.push(line);
          if (line.startsWith("EHLO ")) {
            socket.write("250-fake-smtp.invalid\r\n250 8BITMIME\r\n");
          } else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) {
            socket.write("250 2.1.0 accepted\r\n");
          } else if (line === "DATA") {
            messageLines = [];
            socket.write("354 End data with <CRLF>.<CRLF>\r\n");
          } else if (line === "QUIT") {
            socket.end("221 2.0.0 closing\r\n");
          } else {
            socket.write("502 5.5.1 unsupported command\r\n");
          }
        }
        end = pending.indexOf("\r\n");
      }
    });
    socket.write("220 fake-smtp.invalid ESMTP\r\n");
  });

  // 只绑定回环地址的临时端口；假服务不提供 AUTH 或 STARTTLS，不接触真实 SMTP 和凭据。
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("FAKE_SMTP_LISTEN_ADDRESS_INVALID");
  }
  return {
    port: address.port,
    commands,
    messages,
    errors,
    async close() {
      // 即使断言或发信失败也销毁已接入连接，避免 server.close 永久等待客户端。
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("Nodemailer 真实兼容性", () => {
  it("10.0.9 的真实 ESM 命名导入与 CommonJS 入口均支持结构化发信", async () => {
    expect(require("nodemailer/package.json").version).toBe("10.0.9");
    const commonJs = require("nodemailer") as typeof import("nodemailer");
    for (const factory of [createTransport, commonJs.createTransport]) {
      const transport = factory({ jsonTransport: true });
      try {
        const info = await transport.sendMail({
          from: { address: "no-reply@example.invalid", name: "Hoox 通知" },
          to: "recipient@example.invalid",
          subject: "邮箱验证码",
          text: "你的验证码是 123456",
        });
        expect(info.envelope).toEqual({
          from: "no-reply@example.invalid",
          to: ["recipient@example.invalid"],
        });
        if (typeof info.message !== "string") {
          throw new TypeError("JSON transport 必须返回序列化字符串");
        }
        expect(JSON.parse(info.message)).toMatchObject({
          from: { address: "no-reply@example.invalid", name: "Hoox 通知" },
          subject: "邮箱验证码",
          text: "你的验证码是 123456",
        });
      } finally {
        transport.close();
      }
    }
  });

  it("真实 SMTP transport 将 MIME 邮件发送到回环假服务并返回投递结果", async () => {
    const smtp = await startFakeSmtp();
    // 明文仅用于回环夹具；不复用或放宽生产源码的强制 TLS 配置。
    const transport = createTransport({
      host: "127.0.0.1",
      port: smtp.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 1_000,
      greetingTimeout: 1_000,
      socketTimeout: 2_000,
    });
    try {
      const info = await transport.sendMail({
        from: { address: "no-reply@example.invalid", name: "Hoox 通知" },
        to: "recipient@example.invalid",
        subject: "Compatibility verification",
        text: "Compatibility verification code: 123456\n.dot-stuffed line",
      });
      expect(info.accepted).toEqual(["recipient@example.invalid"]);
      expect(info.rejected).toEqual([]);
      expect(info.response).toBe("250 2.0.0 accepted");
      expect(info.messageId).toBeTypeOf("string");
      expect(smtp.commands).toEqual(
        expect.arrayContaining([
          "MAIL FROM:<no-reply@example.invalid>",
          "RCPT TO:<recipient@example.invalid>",
          "DATA",
        ]),
      );
      expect(smtp.commands.some((command) => command.startsWith("AUTH"))).toBe(false);
      expect(smtp.commands).not.toContain("STARTTLS");
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toContain("Subject: Compatibility verification");
      expect(smtp.messages[0]).toContain("Compatibility verification code: 123456");
      expect(smtp.messages[0]).toContain("\r\n.dot-stuffed line");
      expect(smtp.errors).toEqual([]);
    } finally {
      transport.close();
      await smtp.close();
    }
  });
});
