import { createHash } from "node:crypto";

export type ReadCommandClassification =
  | { kind: "reads"; paths: string[]; successProvenPaths: string[]; hasUnknownRelevant?: true }
  | { kind: "negative" }
  | { kind: "unknown" };

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens;
}

function fileArguments(command: string, tokens: string[]): string[] | undefined {
  if (tokens.length < 2) return undefined;
  const [name, ...args] = tokens;
  if (name === "cat") {
    const files = args.filter((argument) => argument !== "--");
    return files.length > 0 && files.every((argument) => !argument.startsWith("-")) ? files : undefined;
  }
  if (name === "sed") {
    if (args[0] !== "-n" || !args[1] || args[1].startsWith("-")) return undefined;
    const files = args.slice(2).filter((argument) => argument !== "--");
    return files.length > 0 && files.every((argument) => !argument.startsWith("-")) ? files : undefined;
  }
  if (name === "head" || name === "tail") {
    const files = [...args];
    if (files[0] === "-n") files.splice(0, 2);
    else if (files[0]?.startsWith("-n")) files.shift();
    if (files[0] === "--") files.shift();
    return files.length > 0 && files.every((argument) => !argument.startsWith("-")) ? files : undefined;
  }
  return undefined;
}

type ShellOperator = "start" | "&&" | "||" | "|" | ";" | "\n";

function splitCommands(command: string): Array<{ text: string; before: ShellOperator }> | undefined {
  const parts: Array<{ text: string; before: ShellOperator }> = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let before: ShellOperator = "start";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const operator: ShellOperator | undefined =
      char === "&" && command[index + 1] === "&" ? "&&" :
      char === "|" && command[index + 1] === "|" ? "||" :
      char === ";" ? ";" :
      char === "|" ? "|" :
      char === "\n" ? "\n" : undefined;
    if (operator) {
      if (!current.trim()) return undefined;
      parts.push({ text: current.trim(), before });
      current = "";
      before = operator;
      if (operator === "&&" || operator === "||") index += 1;
      continue;
    }
    current += char;
  }
  if (quote || !current.trim()) return undefined;
  parts.push({ text: current.trim(), before });
  return parts;
}

function knownNegative(command: string): boolean {
  return /^(?:echo|printf|find|rg|grep|ls|fd)\b/.test(command.trim()) ||
    /^sed\s+-i\b/.test(command.trim());
}

export function classifyReadCommand(command: string): ReadCommandClassification {
  const segments = splitCommands(command);
  if (!segments) return command.includes("SKILL.md") ? { kind: "unknown" } : { kind: "negative" };
  const paths: string[] = [];
  const successProvenPaths: string[] = [];
  let unknownRelevant = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const relevant = segment.text.includes("SKILL.md");
    if (/[<>`]|\$\(/.test(segment.text)) {
      unknownRelevant ||= relevant;
      continue;
    }
    if (knownNegative(segment.text)) continue;
    const tokens = tokenize(segment.text);
    if (!tokens) {
      unknownRelevant ||= relevant;
      continue;
    }
    const files = fileArguments(segment.text, tokens);
    if (!files) {
      unknownRelevant ||= relevant;
      continue;
    }
    const readPaths = files.filter((path) => path.endsWith("/SKILL.md") || path === "SKILL.md");
    paths.push(...readPaths);
    const successProven =
      !segments.slice(0, index).some((item) => item.before === "||") &&
      !segments.slice(index + 1).some((item) => item.before !== "&&");
    if (successProven) successProvenPaths.push(...readPaths);
  }
  if (paths.length > 0) return { kind: "reads", paths, successProvenPaths, ...(unknownRelevant ? { hasUnknownRelevant: true as const } : {}) };
  return unknownRelevant ? { kind: "unknown" } : { kind: "negative" };
}

export function skillId(platform: string, name: string): string {
  const normalizedName = name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return createHash("sha256")
    .update(`${platform}\u0000${normalizedName}`)
    .digest("hex");
}
