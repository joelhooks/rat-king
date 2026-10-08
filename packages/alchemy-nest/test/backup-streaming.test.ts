import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { localExec } from "../src/local-exec.ts";
import { s3Script } from "../src/s3-script.ts";

const streamingFixture = String.raw`
import contextlib, hashlib, http.client, io, json, pathlib, resource, signal, sys, tarfile, tempfile, time, urllib.parse
script, count = sys.argv[1], int(sys.argv[2])
payload = b'example object payload' * 3
etag = '"' + hashlib.md5(payload).hexdigest() + '"'
gets, pages, max_members = 0, 0, 0
class Connection:
    def __init__(self, *args, **kwargs): pass
    def request(self, method, url, body, headers): self.url = url
    def getresponse(self):
        global gets, pages
        if '?' in self.url:
            pages += 1
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.url).query)
            start = int(query.get('continuation-token', ['0'])[0])
            end = min(count, start + 1000)
            body = ('<ListBucketResult>' + ''.join('<Contents><Key>cells/%09d</Key><ETag>&quot;%s&quot;</ETag></Contents>' % (i, etag.strip('"')) for i in range(start, end)) + '<IsTruncated>' + str(end < count).lower() + '</IsTruncated>' + ('<NextContinuationToken>%d</NextContinuationToken>' % end if end < count else '') + '</ListBucketResult>').encode()
        else:
            gets += 1
            body = payload
        response = io.BytesIO(body)
        response.status = 200
        response.getheader = lambda name, default='': etag if name == 'ETag' else default
        return response
    def close(self): pass
http.client.HTTPConnection = Connection
original_add = tarfile.TarFile.addfile
original_next = tarfile.TarFile.next
def bounded_add(self, *args, **kwargs):
    global max_members
    result = original_add(self, *args, **kwargs)
    max_members = max(max_members, len(self.members))
    assert len(self.members) <= 2, 'Writer retained a full archive'
    return result
def bounded_next(self, *args, **kwargs):
    result = original_next(self, *args, **kwargs)
    assert len(self.members) <= 2, 'Reader retained a full archive'
    return result
tarfile.TarFile.addfile, tarfile.TarFile.next = bounded_add, bounded_next
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    config, target = root/'s3.json', root/'objects.tar'
    config.write_text(json.dumps({'identities':[{'credentials':[{'accessKey':'invented-access','secretKey':'invented-secret'}]}]}))
    timings = {}
    for action in ['prepare', 'export-final', 'pack']:
        sys.argv = ['s3', str(config), 'http://127.0.0.1:18333', 'bucket', action, str(target)]
        namespace = {}
        began = time.monotonic()
        with contextlib.redirect_stdout(io.StringIO()): exec(script, namespace)
        signal.alarm(0)
        timings[action] = round(time.monotonic() - began, 3)
    assert gets == count, 'Final unchanged listing fetched the entire store again'
    began = time.monotonic()
    with tarfile.open(target) as archive:
        assert namespace['validate_export'](archive) == count
    timings['validate'] = round(time.monotonic() - began, 3)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    rss_bytes = rss if sys.platform == 'darwin' else rss * 1024
    assert rss_bytes < 128 * 1024 * 1024, 'Python memory budget exceeded'
    print(json.dumps({'objects':count,'rssBytes':rss_bytes,'seconds':timings,'gets':gets,'pages':pages,'maxRetainedTarMembers':max_members,'archiveBytes':target.stat().st_size}))
`;

it.effect.prop(
  "paginated pre-copy, unchanged delta and streaming validation retain at most two tar members",
  {
    count: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 70, minimum: 1 }))
    ),
  },
  ({ count }) =>
    Effect.gen(function* boundedStreaming() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        streamingFixture,
        s3Script,
        String(count),
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        gets: count,
        maxRetainedTarMembers: 1,
        objects: count,
      });
    }).pipe(Effect.provide(NodeServices.layer))
);
