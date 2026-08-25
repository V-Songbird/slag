// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "hardcoded-secret";
export const title = "Credential or token written into source";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "heuristic",
    "params": {
      "patterns": [
        "(?:[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy])\\b\\s*[:=]\\s*[\"'`][^\"'`\\n]{8,}[\"'`]",
        "[\"'`]sk-[A-Za-z0-9_-]{16,}[\"'`]",
        "[\"'`]gh[pousr]_[A-Za-z0-9]{20,}[\"'`]",
        "[\"'`]AKIA[0-9A-Z]{16}[\"'`]",
        "[\"'`]-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
      ],
      "paths": [
        "*/scripts/**/*.js",
        "*/hooks/**/*.js",
        "*/scripts/*.js",
        "*/hooks/*.js"
      ],
      "stripComments": true,
      "stripStrings": false,
      "perLine": false
    }
  }
];

export const deny = {
  "reason": "Credential or token written into source. Inlines a key it found in a log, a fixture or an error message to make an integration test run.",
  "alternative": "This detector runs with strings intact — it must, since the secret is the string — so it is the noisiest in the edition: a fixture password like 'correct-horse-battery' matches, and so does any long placeholder, which is why test and fixture paths usually need excluding by path. Fix the occurrence, or narrow this guard's paths in .jig/config.json if it is wrong about this file.",
  "override": "Change the paths on this check, or retire it in /jig:review, if it turns out to be wrong here more often than right."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "export const config = {\n  region: 'eu-central-1',\n  apiKey: 'sk-live-9fJ2kQ4mZp01xR7bV8dLn3TuA',\n  clientSecret: 'ZmFrZS1jbGllbnQtc2VjcmV0LXZhbHVl',\n  githubToken: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',\n  awsKeyId: 'AKIAIOSFODNN7EXAMPLE',\n  signingKey: '-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAKj34G\\n-----END RSA PRIVATE KEY-----',\n};\n\nexport function authHeader() {\n  return { authorization: `Bearer ${config.apiKey}` };\n}\n",
  "nearMiss": "const required = (name) => {\n  const value = process.env[name];\n  if (!value) throw new Error(`missing required environment variable ${name}`);\n  return value;\n};\n\nexport const config = {\n  region: 'eu-central-1',\n  apiKey: required('BILLING_API_KEY'),\n  clientSecret: required('BILLING_CLIENT_SECRET'),\n};\n\nconst tokenHeader = 'authorization';\n\nexport function authHeader() {\n  return { [tokenHeader]: `Bearer ${config.apiKey}` };\n}\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
