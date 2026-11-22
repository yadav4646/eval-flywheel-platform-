// Line prompter that never drops input: lines that arrive before a question is
// asked (piped/scripted input, fast typing) are queued instead of lost.
import { createInterface } from "node:readline";

export interface Prompter {
  ask(question: string): Promise<string | null>; // null = input closed
  close(): void;
}

export function createPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  const rl = createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiting: ((l: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queue.push(line)));
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()!(null);
  });
  return {
    ask(question) {
      output.write(question);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}
