import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE_SERVICE_ALLOWLIST } from "../../scripts/host_apply/compose_policy.ts";
import {
  COMPOSE_IMAGE_TABLE,
  COMPOSE_SECRET_TABLE,
  type ComposeViolation,
  checkComposeTablesText,
  TAG_VARIABLE_NAMES,
} from "../../scripts/host_apply/compose_tables.ts";
import {
  MAX_BLOB_BYTES,
  MISE_ENV_KEYS,
} from "../../scripts/host_apply/constants.ts";
import { COMPOSE_ENV_NAMES } from "../../scripts/host_apply/env.ts";
import { validateMiseValue } from "../../scripts/host_apply/mise_policy.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const REAL_COMPOSE = readFileSync(
  join(REPO_ROOT, "infra/docker-compose.yml"),
  "utf8",
);

type Services = Record<string, Record<string, unknown>>;

/** JSONはYAMLとして読めるので、構造をそのまま文書にする。 */
function textOf(services: Services, top: Record<string, unknown> = {}): string {
  return JSON.stringify({ services, ...top });
}

function summarize(v: ComposeViolation): string {
  return `${v.kind}:${v.service}:${v.field}:${v.subject}`;
}

/** 違反を`kind:service:field:subject`の並びにする。拒否なら`rejected`。 */
function found(
  services: Services,
  top: Record<string, unknown> = {},
): string[] | "rejected" {
  const result = checkComposeTablesText(textOf(services, top));
  return result.ok ? result.violations.map(summarize) : "rejected";
}

function foundText(text: string): string[] | "rejected" {
  const result = checkComposeTablesText(text);
  return result.ok ? result.violations.map(summarize) : "rejected";
}

function violationsOf(text: string): readonly ComposeViolation[] {
  const result = checkComposeTablesText(text);
  return result.ok ? result.violations : [];
}

const DB = { image: "postgres:18" };
const WORKER = { build: "./worker" };

describe("the tables", () => {
  test("the image table has the same services as the allowlist", () => {
    expect(Object.keys(COMPOSE_IMAGE_TABLE).sort()).toEqual(
      [...COMPOSE_SERVICE_ALLOWLIST].sort(),
    );
  });

  test("the secret names are the compose names that are not mise keys", () => {
    expect(Object.keys(COMPOSE_SECRET_TABLE).sort()).toEqual(
      COMPOSE_ENV_NAMES.filter((name) => !MISE_ENV_KEYS.includes(name)).sort(),
    );
  });

  test("every service of the secret table is in the allowlist", () => {
    expect(
      Object.values(COMPOSE_SECRET_TABLE)
        .flat()
        .filter((service) => !COMPOSE_SERVICE_ALLOWLIST.includes(service)),
    ).toEqual([]);
  });

  test("the tag variables are mise keys", () => {
    expect(
      TAG_VARIABLE_NAMES.filter((name) => !MISE_ENV_KEYS.includes(name)),
    ).toEqual([]);
  });

  test.each(["a/b", "a:b", "a@b"])(
    "no tag variable accepts a value with %s",
    (value) => {
      expect(
        TAG_VARIABLE_NAMES.filter((name) => validateMiseValue(name, value)),
      ).toEqual([]);
    },
  );
});

describe("the real infra/docker-compose.yml", () => {
  test("has no violation", () => {
    expect(foundText(REAL_COMPOSE)).toEqual([]);
  });

  test("refers only to names that the executor knows", () => {
    const names = [
      ...REAL_COMPOSE.replace(/^\s*#.*$/gm, "").matchAll(
        /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g,
      ),
    ]
      .map((match) => match[1] ?? "")
      .filter((name) => !COMPOSE_ENV_NAMES.includes(name));
    expect(names).toEqual([]);
  });

  test("has no tag and no merge key", () => {
    expect(/!|<</.test(REAL_COMPOSE)).toBe(false);
  });
});

describe("images", () => {
  test("a repository outside the table is a violation", () => {
    expect(found({ db: { image: "redis:7" } })).toEqual([
      "image:db:image:redis:7",
    ]);
  });

  test("a different tag is not a violation", () => {
    expect(found({ db: { image: "postgres:17" } })).toEqual([]);
  });

  test("a digest is not a violation", () => {
    expect(
      found({ db: { image: `postgres@sha256:${"a".repeat(64)}` } }),
    ).toEqual([]);
  });

  test("a tag with a digest is not a violation", () => {
    expect(
      found({ db: { image: `postgres:18@sha256:${"a".repeat(64)}` } }),
    ).toEqual([]);
  });

  test("a version variable in the tag is not a violation", () => {
    expect(
      found({
        windmill_server: {
          image: "ghcr.io/windmill-labs/windmill:${WM_VERSION:?run via mise}",
        },
      }),
    ).toEqual([]);
  });

  test("a variable in the repository name is rejected", () => {
    expect(found({ db: { image: "${REG}/postgres:18" } })).toBe("rejected");
  });

  test("a registry port made of a variable is rejected", () => {
    expect(
      found({ db: { image: "postgres:${WM_HTTP_PORT}/evil/img:1" } }),
    ).toBe("rejected");
  });

  test("a default value with a slash is rejected", () => {
    expect(found({ db: { image: "postgres:${U:-5000/x/y}" } })).toBe(
      "rejected",
    );
  });

  test("a tag variable that is not a version name is rejected", () => {
    expect(
      found({
        db: { image: "postgres:${CONSOLE_GITHUB_REPO:?x}" },
      }),
    ).toBe("rejected");
  });

  test("an alias of the registry is a violation", () => {
    expect(found({ db: { image: "docker.io/library/postgres:18" } })).toEqual([
      "image:db:image:docker.io/library/postgres:18",
    ]);
  });

  test("a missing image is a violation", () => {
    expect(found({ db: {} })).toEqual(["image:db:image:(none)"]);
  });

  test("an image that is not a string is a violation", () => {
    expect(found({ db: { image: 7 } })).toEqual([
      "image:db:image:(not a string)",
    ]);
  });

  test("a build service with an image is a violation", () => {
    expect(found({ windmill_worker: { ...WORKER, image: "evil:1" } })).toEqual([
      "image:windmill_worker:image:evil:1",
    ]);
  });

  test("a build service with a variable in the image is a violation", () => {
    expect(
      found({ windmill_worker: { ...WORKER, image: "evil:${WM_VERSION}" } }),
    ).toEqual(["image:windmill_worker:image:evil:${WM_VERSION}"]);
  });

  test("a build service without build is a violation", () => {
    expect(found({ windmill_worker: {} })).toEqual([
      "image:windmill_worker:build:(no build)",
    ]);
  });

  test("an image service with a build map is a violation", () => {
    expect(found({ db: { ...DB, build: { context: "." } } })).toEqual([
      "image:db:build:build",
    ]);
  });

  test("an image service with a short build is a violation", () => {
    expect(found({ db: { ...DB, build: "./x" } })).toEqual([
      "image:db:build:build",
    ]);
  });

  test("a short build of a build service counts as a build", () => {
    expect(found({ windmill_worker: { build: "./worker" } })).toEqual([]);
  });

  test("a repository in other letter case is a violation", () => {
    expect(found({ db: { image: "Postgres:18" } })).toEqual([
      "image:db:image:Postgres:18",
    ]);
  });

  test("a service outside the allowlist is rejected", () => {
    expect(found({ evil: { image: "x" } })).toBe("rejected");
  });

  test("a service of the table that is absent is not a violation", () => {
    expect(found({})).toEqual([]);
  });
});

describe("secrets", () => {
  test("an environment list entry of a table service is not a violation", () => {
    expect(
      found({ db: { ...DB, environment: ["P=${DB_PASSWORD:?run via mise}"] } }),
    ).toEqual([]);
  });

  test("an environment map value of a table service is not a violation", () => {
    expect(
      found({ db: { ...DB, environment: { P: "${DB_PASSWORD}" } } }),
    ).toEqual([]);
  });

  test("the secret in a service outside the table is a violation", () => {
    expect(
      found({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          environment: ["P=${DB_PASSWORD}"],
        },
      }),
    ).toEqual(["secret:caddy:environment:DB_PASSWORD"]);
  });

  test("the token in its own service is not a violation", () => {
    expect(
      found({
        console_fetcher: {
          build: "./c",
          environment: ["T=${CONSOLE_GITHUB_TOKEN:-}"],
        },
      }),
    ).toEqual([]);
  });

  test("the token in another table service is a violation", () => {
    expect(
      found({ db: { ...DB, environment: ["T=${CONSOLE_GITHUB_TOKEN}"] } }),
    ).toEqual(["secret:db:environment:CONSOLE_GITHUB_TOKEN"]);
  });

  test("a table service may not read the secret in the command", () => {
    expect(
      found({ db: { ...DB, command: ["echo", "${DB_PASSWORD}"] } }),
    ).toEqual(["secret:db:command:DB_PASSWORD"]);
  });

  test("a table service may not read the secret in a label", () => {
    expect(found({ db: { ...DB, labels: { x: "${DB_PASSWORD}" } } })).toEqual([
      "secret:db:labels:DB_PASSWORD",
    ]);
  });

  test("a table service may not read the secret in a build arg", () => {
    expect(
      found({
        windmill_worker: {
          build: { context: ".", args: { X: "$DB_PASSWORD" } },
        },
      }),
    ).toEqual(["secret:windmill_worker:build:DB_PASSWORD"]);
  });

  test("a table service may not read the secret in the image", () => {
    expect(found({ db: { image: "postgres:${DB_PASSWORD}" } })).toBe(
      "rejected",
    );
  });

  test("a reference in a map key is a violation", () => {
    expect(
      found({ db: { ...DB, environment: { "${DB_PASSWORD}": "x" } } }),
    ).toEqual(["secret:db:environment:DB_PASSWORD"]);
  });

  test("a reference in the name of a list entry is a violation", () => {
    expect(found({ db: { ...DB, environment: ["${DB_PASSWORD}=x"] } })).toEqual(
      ["secret:db:environment:DB_PASSWORD"],
    );
  });

  test("a bare name for a table service is not a violation", () => {
    expect(found({ db: { ...DB, environment: ["DB_PASSWORD"] } })).toEqual([]);
  });

  test("a bare name in a list passes the value of the host", () => {
    expect(
      found({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          environment: ["DB_PASSWORD"],
        },
      }),
    ).toEqual(["secret:caddy:environment:DB_PASSWORD"]);
  });

  test("a null value in a map passes the value of the host", () => {
    expect(
      found({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          environment: { DB_PASSWORD: null },
        },
      }),
    ).toEqual(["secret:caddy:environment:DB_PASSWORD"]);
  });

  test("a bare name with spaces around it is still a reference", () => {
    expect(
      found({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          environment: [" DB_PASSWORD "],
        },
      }),
    ).toEqual(["secret:caddy:environment:DB_PASSWORD"]);
  });

  test("a bare name with a space inside is rejected", () => {
    expect(
      found({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          environment: ["DB PASSWORD"],
        },
      }),
    ).toBe("rejected");
  });

  test("a bare name in the build args is a violation", () => {
    expect(
      found({
        windmill_worker: {
          build: { context: ".", args: ["CONSOLE_GITHUB_TOKEN"] },
        },
      }),
    ).toEqual(["secret:windmill_worker:build:CONSOLE_GITHUB_TOKEN"]);
  });

  test("a longer name is judged as its own name", () => {
    expect(found({ db: { ...DB, labels: { x: "$DB_PASSWORD_X" } } })).toBe(
      "rejected",
    );
  });

  test("a name that continues with letters is judged as its own name", () => {
    expect(found({ db: { ...DB, environment: ["X=${DB_PASSWORDS}"] } })).toBe(
      "rejected",
    );
  });

  test("a doubled dollar still counts as a reference", () => {
    expect(
      found({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          environment: ["X=$$DB_PASSWORD"],
        },
      }),
    ).toEqual(["secret:caddy:environment:DB_PASSWORD"]);
  });

  test("an escaped dollar in a quoted scalar is rejected", () => {
    expect(
      foundText(
        'services:\n  caddy:\n    image: ghcr.io/windmill-labs/caddy-l4:1\n    labels:\n      x: "\\x24{DB_PASSWORD}"\n',
      ),
    ).toBe("rejected");
  });

  test("an escaped merge key is rejected", () => {
    expect(
      foundText(
        'x: &a {A: b}\nservices:\n  db:\n    image: postgres:18\n    environment:\n      "\\x3c\\x3c": *a\n',
      ),
    ).toBe("rejected");
  });

  test("another secret of the host is rejected", () => {
    expect(found({ db: { ...DB, labels: { x: "${GITHUB_TOKEN}" } } })).toBe(
      "rejected",
    );
  });

  test("an admin password is rejected", () => {
    expect(
      found({ db: { ...DB, environment: ["X=${WM_ADMIN_PASSWORD}"] } }),
    ).toBe("rejected");
  });

  test("an unknown name is rejected", () => {
    expect(found({ db: { ...DB, labels: { x: "${NOPE}" } } })).toBe("rejected");
  });

  test("HOME is a violation", () => {
    expect(found({ db: { ...DB, labels: { x: "${HOME}" } } })).toEqual([
      "secret:db:labels:HOME",
    ]);
  });

  test("a mise key is not a violation", () => {
    expect(found({ db: { ...DB, labels: { x: "${WM_BIND}" } } })).toEqual([]);
  });

  test("a secret in a top-level volume label is a violation", () => {
    expect(
      found({}, { volumes: { v: { labels: { x: "${DB_PASSWORD}" } } } }),
    ).toEqual(["secret:(top):volumes:DB_PASSWORD"]);
  });

  test("a host secret in a top-level network label is rejected", () => {
    expect(
      found({}, { networks: { n: { labels: { x: "${GITHUB_TOKEN}" } } } }),
    ).toBe("rejected");
  });

  test("a secret in an extension field is a violation", () => {
    expect(found({}, { "x-a": { y: "${DB_PASSWORD}" } })).toEqual([
      "secret:(top):x-a:DB_PASSWORD",
    ]);
  });
});

describe("references in keys", () => {
  test("a reference in a top-level key is judged", () => {
    expect(found({}, { "x-${GITHUB_TOKEN}": 1 })).toBe("rejected");
  });

  test("a reference in a field name of a service is judged", () => {
    expect(found({ db: { ...DB, "x-${HOME}": 1 } })).toEqual([
      "secret:db:x-${HOME}:HOME",
    ]);
  });
});

describe("raw text checks at the entry of the tables", () => {
  const BASE = "services:\n  db:\n    image: postgres:18\n";

  test.each(["\u0085", "\u2028", "\u2029", "\r"])(
    "rejects the line break %j",
    (mark) => {
      expect(foundText(`${BASE}# a${mark}b\n`)).toBe("rejected");
    },
  );

  test("rejects a tag in a comment", () => {
    expect(foundText(`# !x\n${BASE}`)).toBe("rejected");
  });

  test("rejects a merge key in a comment", () => {
    expect(foundText(`# <<\n${BASE}`)).toBe("rejected");
  });
});

describe("ids of violations", () => {
  const idsOf = (services: Services) =>
    violationsOf(textOf(services)).map((item) => item.id);
  const caddy = { image: "ghcr.io/windmill-labs/caddy-l4:1" };

  test("two names in one scalar make two violations", () => {
    expect(
      found({ caddy: { ...caddy, labels: { a: "${DB_PASSWORD}${HOME}" } } }),
    ).toEqual(["secret:caddy:labels:DB_PASSWORD", "secret:caddy:labels:HOME"]);
  });

  test("a different build gives a different id", () => {
    expect(idsOf({ db: { ...DB, build: { context: "./a" } } }).join()).not.toBe(
      idsOf({ db: { ...DB, build: { context: "./b" } } }).join(),
    );
  });

  test("an image that is not a string gives an id for its value", () => {
    expect(idsOf({ db: { image: { a: 1 } } }).join()).not.toBe(
      idsOf({ db: { image: ["evil"] } }).join(),
    );
  });

  test("the key of a map value is part of the id", () => {
    expect(
      idsOf({
        caddy: { ...caddy, environment: { A: "${CONSOLE_GITHUB_TOKEN}" } },
      }).join(),
    ).not.toBe(
      idsOf({
        caddy: { ...caddy, environment: { B: "${CONSOLE_GITHUB_TOKEN}" } },
      }).join(),
    );
  });
});

describe("shared nodes, limits and cycles", () => {
  const CADDY = "image: ghcr.io/windmill-labs/caddy-l4:1";

  test("a node shared by a table service and another service is counted for both", () => {
    const text = `services:\n  db:\n    image: postgres:18\n    environment: &e ["X=\${DB_PASSWORD}"]\n  caddy:\n    ${CADDY}\n    environment: *e\n`;
    expect(foundText(text)).toEqual(["secret:caddy:environment:DB_PASSWORD"]);
  });

  test("a list shared by labels and environment is counted for both fields", () => {
    const text = `services:\n  db:\n    image: postgres:18\n    labels: &e ["X=\${DB_PASSWORD}"]\n    environment: *e\n`;
    expect(foundText(text)).toEqual(["secret:db:labels:DB_PASSWORD"]);
  });

  test("the same node in two services is counted in each", () => {
    const text = `services:\n  caddy:\n    ${CADDY}\n    labels: &e {a: "\${DB_PASSWORD}"}\n  windmill_extra:\n    image: ghcr.io/windmill-labs/windmill-extra:1\n    labels: *e\n`;
    expect(foundText(text)).toEqual([
      "secret:caddy:labels:DB_PASSWORD",
      "secret:windmill_extra:labels:DB_PASSWORD",
    ]);
  });

  test("a cycle through an alias is rejected", () => {
    expect(
      foundText("services:\n  db:\n    image: postgres:18\n    x: &a [*a]\n"),
    ).toBe("rejected");
  });

  test("a document over the size limit is rejected", () => {
    expect(foundText(`# ${"a".repeat(MAX_BLOB_BYTES)}\nservices: {}\n`)).toBe(
      "rejected",
    );
  });

  test("a document that is not YAML is rejected", () => {
    expect(foundText("a: [")).toBe("rejected");
  });

  test("a document whose services is not a map is rejected", () => {
    expect(foundText("services: [a]\n")).toBe("rejected");
  });

  test("a hidden tag is rejected", () => {
    expect(foundText('services: {"db": {"x":!!binary YQ==}}')).toBe("rejected");
  });

  test("a merge key is rejected", () => {
    expect(foundText("x: &a {k: 1}\nservices:\n  db:\n    <<: *a\n")).toBe(
      "rejected",
    );
  });

  test("a document with a carriage return is rejected", () => {
    expect(foundText("services: {}\r\n")).toBe("rejected");
  });

  const nested = (depth: number) =>
    `services:\n  db:\n    image: postgres:18\n    labels: ${"[".repeat(depth)}${"]".repeat(depth)}\n`;
  const limits = (
    over: Partial<{
      maxDepth: number;
      maxNodes: number;
      maxBytes: number;
      maxRefs: number;
    }>,
  ) => ({
    maxDepth: 64,
    maxNodes: 100_000,
    maxBytes: 8 * 1024 * 1024,
    maxRefs: 1_000_000,
    ...over,
  });

  test("a depth below the limit is accepted", () => {
    expect(
      checkComposeTablesText(nested(10), limits({ maxDepth: 12 })).ok,
    ).toBe(true);
  });

  test("a depth over the limit is rejected", () => {
    expect(
      checkComposeTablesText(nested(20), limits({ maxDepth: 12 })).ok,
    ).toBe(false);
  });

  const wide = `services:\n  db:\n    image: postgres:18\n    labels: {a: x, b: y}\n`;

  test("a node count at the limit is accepted", () => {
    expect(checkComposeTablesText(wide, limits({ maxNodes: 4 })).ok).toBe(true);
  });

  test("a node count over the limit is rejected", () => {
    expect(checkComposeTablesText(wide, limits({ maxNodes: 3 })).ok).toBe(
      false,
    );
  });

  test("a string total below the limit is accepted", () => {
    expect(checkComposeTablesText(wide, limits({ maxBytes: 1_000 })).ok).toBe(
      true,
    );
  });

  test("a string total over the limit is rejected", () => {
    expect(checkComposeTablesText(wide, limits({ maxBytes: 10 })).ok).toBe(
      false,
    );
  });

  test("a reference count below the limit is accepted", () => {
    const text = `services:\n  db:\n    image: postgres:18\n    labels: ["\${WM_BIND}", "\${WM_VERSION}"]\n`;
    expect(checkComposeTablesText(text, limits({ maxRefs: 100 })).ok).toBe(
      true,
    );
  });

  test("a reference count over the limit is rejected", () => {
    const text = `services:\n  db:\n    image: postgres:18\n    labels: ["\${WM_BIND}", "\${WM_VERSION}"]\n`;
    expect(checkComposeTablesText(text, limits({ maxRefs: 1 })).ok).toBe(false);
  });

  test("many aliases of a large list finish quickly", () => {
    const leaf = `["\${WM_VERSION}", "\${WM_BIND}"]`;
    const aliases = Array.from({ length: 400 }, () => "*l0").join(", ");
    const text = `x-l0: &l0 ${leaf}\nx-l1: &l1 [${aliases}]\n${Array.from(
      { length: 300 },
      (_, index) => `x-k${index}: *l1`,
    ).join("\n")}\nservices:\n  db:\n    image: postgres:18\n`;
    const started = Date.now();
    const result = checkComposeTablesText(text);
    expect([result.ok, Date.now() - started < 3000]).toEqual([true, true]);
  });

  test("the detail of a rejection is printable ASCII", () => {
    const result = checkComposeTablesText(textOf({ évil: { image: "x" } }));
    expect(/^[\x20-\x7e]+$/.test(result.ok ? "" : result.detail)).toBe(true);
  });
});

describe("ids and order", () => {
  const caddy = (env: unknown) => ({
    caddy: { image: "ghcr.io/windmill-labs/caddy-l4:1", environment: env },
  });
  const idOf = (services: Services) =>
    violationsOf(textOf(services))[0]?.id ?? "";

  test("the same violation has the same id", () => {
    expect(idOf(caddy(["A=${DB_PASSWORD}"]))).toBe(
      idOf(caddy(["A=${DB_PASSWORD}"])),
    );
  });

  test("a different service gives a different id", () => {
    expect(idOf(caddy(["A=${DB_PASSWORD}"]))).not.toBe(
      idOf({
        windmill_extra: {
          image: "ghcr.io/windmill-labs/windmill-extra:1",
          environment: ["A=${DB_PASSWORD}"],
        },
      }),
    );
  });

  test("a different field gives a different id", () => {
    expect(idOf(caddy(["A=${DB_PASSWORD}"]))).not.toBe(
      idOf({
        caddy: {
          image: "ghcr.io/windmill-labs/caddy-l4:1",
          labels: ["A=${DB_PASSWORD}"],
        },
      }),
    );
  });

  test("a different scalar with the same name gives a different id", () => {
    expect(idOf(caddy(["A=${DB_PASSWORD}"]))).not.toBe(
      idOf(caddy(["B=https://evil/${DB_PASSWORD}"])),
    );
  });

  test("a different image gives a different id", () => {
    expect(idOf({ db: { image: "redis:7" } })).not.toBe(
      idOf({ db: { image: "redis:8" } }),
    );
  });

  test("two references in one scalar make one violation", () => {
    expect(found(caddy(["A=${DB_PASSWORD}${DB_PASSWORD}"]))).toEqual([
      "secret:caddy:environment:DB_PASSWORD",
    ]);
  });

  test("violations are ordered by service in code units", () => {
    expect(
      found({
        windmill_extra: { image: "x" },
        caddy: { image: "y" },
      }),
    ).toEqual(["image:caddy:image:y", "image:windmill_extra:image:x"]);
  });

  test("violations of one service are ordered by kind", () => {
    expect(
      found({
        caddy: { image: "y", labels: { a: "${DB_PASSWORD}" } },
      }),
    ).toEqual(["image:caddy:image:y", "secret:caddy:labels:DB_PASSWORD"]);
  });

  test("a long subject is cut and shows the length", () => {
    const subject = violationsOf(
      textOf({ db: { image: `r${"x".repeat(300)}` } }),
    )[0]?.subject;
    expect(subject).toBe(`r${"x".repeat(99)}...(301 chars)`);
  });

  test("a control character in a subject is escaped", () => {
    const subject = violationsOf(textOf({ db: { image: "a\u001bb" } }))[0]
      ?.subject;
    expect(/^[\x20-\x7e]+$/.test(subject ?? "")).toBe(true);
  });
});
