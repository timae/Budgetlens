package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	web, err := fs.Sub(embedded, "web")
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewServer(web)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func do(t *testing.T, h http.Handler, method, target string, hdr map[string]string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func assertSecurityHeaders(t *testing.T, res *http.Response) {
	t.Helper()
	for k, v := range securityHeaders {
		if got := res.Header.Get(k); got != v {
			t.Errorf("%s %s: header %s = %q, want %q", res.Request.Method, res.Request.URL, k, got, v)
		}
	}
}

func TestIndexServedWithSecurityHeaders(t *testing.T) {
	s := newTestServer(t)
	res := do(t, s, "GET", "/", nil)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	assertSecurityHeaders(t, res)
	if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("content-type %q", ct)
	}
	if res.Header.Get("ETag") == "" {
		t.Error("missing ETag")
	}
	body, _ := io.ReadAll(res.Body)
	if !bytes.Contains(body, []byte("Budget Lens")) {
		t.Error("index does not look like the app")
	}
}

func TestCSPDirectives(t *testing.T) {
	for _, d := range []string{
		"default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "img-src 'self'",
		"connect-src 'none'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'",
		"require-trusted-types-for 'script'", "trusted-types 'none'",
	} {
		if !strings.Contains(contentSecurityPolicy, d) {
			t.Errorf("CSP missing %q", d)
		}
	}
	if strings.Contains(contentSecurityPolicy, "unsafe") || strings.Contains(contentSecurityPolicy, "data:") || strings.Contains(contentSecurityPolicy, "http") {
		t.Errorf("CSP too permissive: %s", contentSecurityPolicy)
	}
}

func TestOnlyGetAndHead(t *testing.T) {
	s := newTestServer(t)
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND"} {
		for _, p := range []string{"/", "/index.html", "/upload", "/healthz"} {
			res := do(t, s, m, p, nil)
			if res.StatusCode != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want 405", m, p, res.StatusCode)
			}
			if res.Header.Get("Allow") != "GET, HEAD" {
				t.Errorf("%s %s: Allow = %q", m, p, res.Header.Get("Allow"))
			}
			assertSecurityHeaders(t, res)
		}
	}
	res := do(t, s, "HEAD", "/", nil)
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || len(body) != 0 {
		t.Errorf("HEAD / = %d with %d body bytes", res.StatusCode, len(body))
	}
}

func TestNotFoundAndTraversal(t *testing.T) {
	s := newTestServer(t)
	for _, p := range []string{
		"/nope", "/js/", "/js", "/../main.go", "/js/../../go.mod", "/web/index.html", "/main.go",
		"/js/%2e%2e/index.html", "/.git/config", "/index.html/", "//index.html", "/assets/fonts/",
		"/js\\app.js", "/upload", "/api/files",
	} {
		res := do(t, s, "GET", p, nil)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", p, res.StatusCode)
		}
		assertSecurityHeaders(t, res)
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
			t.Errorf("GET %s content-type %q", p, ct)
		}
	}
}

func TestAllowlistSkipsUnknownTypes(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":       {Data: []byte("<!doctype html><title>Budget Lens</title>")},
		"app.js":           {Data: []byte("1")},
		"secret.env":       {Data: []byte("KEY=1")},
		"notes.md":         {Data: []byte("# x")},
		"app.js.map":       {Data: []byte("{}")},
		".hidden.js":       {Data: []byte("1")},
		".git/config":      {Data: []byte("x")},
		"data/sample.json": {Data: []byte("{}")},
	}
	s, err := NewServer(fsys)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(s.Paths(), ",")
	if got != "/app.js,/index.html" {
		t.Errorf("served paths = %s", got)
	}
}

func TestEmbeddedFilesAreAllAllowlisted(t *testing.T) {
	err := fs.WalkDir(embedded, "web", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if _, ok := contentTypes[path.Ext(p)]; !ok {
			t.Errorf("web/ contains %s, whose type is not served; remove it or extend the allowlist", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGzipAndETag(t *testing.T) {
	s := newTestServer(t)
	plain := do(t, s, "GET", "/js/app.js", nil)
	plainBody, _ := io.ReadAll(plain.Body)
	if plain.StatusCode != 200 || plain.Header.Get("Content-Encoding") != "" {
		t.Fatalf("plain: %d %q", plain.StatusCode, plain.Header.Get("Content-Encoding"))
	}
	if plain.Header.Get("Vary") != "Accept-Encoding" {
		t.Error("missing Vary")
	}
	gz := do(t, s, "GET", "/js/app.js", map[string]string{"Accept-Encoding": "br, gzip;q=0.8"})
	if gz.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected gzip, got %q", gz.Header.Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(gz.Body)
	if err != nil {
		t.Fatal(err)
	}
	unz, _ := io.ReadAll(zr)
	if !bytes.Equal(unz, plainBody) {
		t.Error("gzip body differs from plain body")
	}
	if gz.Header.Get("ETag") == plain.Header.Get("ETag") {
		t.Error("gzip and identity variants share an ETag")
	}
	no := do(t, s, "GET", "/js/app.js", map[string]string{"Accept-Encoding": "gzip;q=0"})
	if no.Header.Get("Content-Encoding") != "" {
		t.Error("gzip served despite q=0")
	}
	nm := do(t, s, "GET", "/js/app.js", map[string]string{"If-None-Match": plain.Header.Get("ETag")})
	if nm.StatusCode != http.StatusNotModified {
		t.Errorf("If-None-Match = %d, want 304", nm.StatusCode)
	}
	assertSecurityHeaders(t, nm)
	font := do(t, s, "GET", "/assets/fonts/archivo-latin.woff2", map[string]string{"Accept-Encoding": "gzip"})
	if font.StatusCode != 200 || font.Header.Get("Content-Encoding") != "" || font.Header.Get("Content-Type") != "font/woff2" {
		t.Errorf("font: %d enc=%q ct=%q", font.StatusCode, font.Header.Get("Content-Encoding"), font.Header.Get("Content-Type"))
	}
}

func TestHealthz(t *testing.T) {
	s := newTestServer(t)
	res := do(t, s, "GET", "/healthz", map[string]string{"X-Forwarded-Proto": "http"})
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "ok\n" {
		t.Errorf("healthz = %d %q", res.StatusCode, body)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Error("healthz cacheable")
	}
	assertSecurityHeaders(t, res)
}

func TestHTTPSRedirect(t *testing.T) {
	s := newTestServer(t)
	res := do(t, s, "GET", "http://budget.example.ch/js/app.js?x=1", map[string]string{"X-Forwarded-Proto": "http"})
	if res.StatusCode != http.StatusPermanentRedirect {
		t.Fatalf("status %d", res.StatusCode)
	}
	if loc := res.Header.Get("Location"); loc != "https://budget.example.ch/js/app.js?x=1" {
		t.Errorf("Location %q", loc)
	}
	assertSecurityHeaders(t, res)
	ok := do(t, s, "GET", "/", map[string]string{"X-Forwarded-Proto": "https"})
	if ok.StatusCode != 200 {
		t.Errorf("https request = %d", ok.StatusCode)
	}
}

func TestListenAddr(t *testing.T) {
	cases := map[string]string{"": ":8080", "9000": ":9000", "08081": ":8081"}
	for in, want := range cases {
		t.Setenv("PORT", in)
		got, err := listenAddr()
		if err != nil || got != want {
			t.Errorf("PORT=%q -> %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"abc", "0", "70000", "80;rm"} {
		t.Setenv("PORT", bad)
		if _, err := listenAddr(); err == nil {
			t.Errorf("PORT=%q accepted", bad)
		}
	}
}

func TestServerTimeouts(t *testing.T) {
	hs := newHTTPServer(":0", http.NotFoundHandler())
	if hs.ReadHeaderTimeout == 0 || hs.ReadTimeout == 0 || hs.WriteTimeout == 0 || hs.IdleTimeout == 0 || hs.MaxHeaderBytes == 0 {
		t.Errorf("timeouts not set: %+v", hs)
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{"": false, "gzip": true, "deflate, gzip": true, "GZIP": true, "gzip;q=0": false,
		"br": false, "*": true, "*;q=0": false, "gzip;q=0.5": true}
	for in, want := range cases {
		if got := acceptsGzip(in); got != want {
			t.Errorf("acceptsGzip(%q) = %v", in, got)
		}
	}
}

// Static checks that the shipped front-end stays CSP/Trusted-Types clean.
func TestFrontendHasNoInlineCodeOrHTMLSinks(t *testing.T) {
	inlineScript := regexp.MustCompile(`(?is)<script(?:\s[^>]*)?>\s*[^<\s]`)
	styleTag := regexp.MustCompile(`(?i)<style`)
	styleAttr := regexp.MustCompile(`(?i)\sstyle\s*=`)
	handlerAttr := regexp.MustCompile(`(?i)\son[a-z]+\s*=`)
	externalRef := regexp.MustCompile(`(?i)(src|href)\s*=\s*["']?(https?:)?//`)
	sinks := regexp.MustCompile(`\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write|\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*["'\x60]|createContextualFragment|DOMParser|\.setAttribute\(\s*['"](style|on\w+)['"]|localStorage|sessionStorage|indexedDB|document\.cookie|fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts`)
	err := fs.WalkDir(embedded, "web", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, _ := fs.ReadFile(embedded, p)
		src := string(b)
		switch path.Ext(p) {
		case ".html":
			for name, re := range map[string]*regexp.Regexp{"inline script": inlineScript, "<style>": styleTag, "style attribute": styleAttr, "event handler attribute": handlerAttr, "external reference": externalRef} {
				if loc := re.FindStringIndex(src); loc != nil {
					t.Errorf("%s: %s at %q", p, name, src[loc[0]:min(len(src), loc[1]+30)])
				}
			}
		case ".js":
			for i, r := range src {
				if r > 0x7e || (r < 0x20 && r != '\n' && r != '\t') {
					t.Errorf("%s: non-ASCII or control character %U at byte %d; use \\u escapes so no invisible characters hide in source", p, r, i)
					break
				}
			}
			if loc := sinks.FindStringIndex(src); loc != nil {
				t.Errorf("%s: forbidden API %q", p, src[loc[0]:loc[1]])
			}
		case ".css":
			if strings.Contains(src, "@import") || regexp.MustCompile(`url\(\s*["']?(https?:)?//`).MatchString(src) {
				t.Errorf("%s: external CSS reference", p)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
