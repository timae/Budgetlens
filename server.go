package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"
)

// contentTypes is the explicit allowlist of file types the server will serve.
// Any embedded file whose extension is not listed here is never reachable.
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".woff2": "font/woff2",
	".txt":   "text/plain; charset=utf-8",
}

// compressible lists the types worth gzipping (woff2 and png are already compressed).
var compressible = map[string]bool{".html": true, ".css": true, ".js": true, ".svg": true, ".txt": true}

// CSP: same-origin scripts/styles/fonts/images only, no network access from
// the page, no framing, no forms, and Trusted Types enforced with no policies
// allowed, so string-to-HTML/script sinks (innerHTML etc.) throw.
const contentSecurityPolicy = "default-src 'none'; " +
	"script-src 'self'; " +
	"style-src 'self'; " +
	"font-src 'self'; " +
	"img-src 'self'; " +
	"connect-src 'none'; " +
	"manifest-src 'none'; " +
	"media-src 'none'; " +
	"object-src 'none'; " +
	"worker-src 'none'; " +
	"frame-src 'none'; " +
	"child-src 'none'; " +
	"frame-ancestors 'none'; " +
	"form-action 'none'; " +
	"base-uri 'none'; " +
	"require-trusted-types-for 'script'; " +
	"trusted-types 'none'"

const permissionsPolicy = "accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), bluetooth=(), " +
	"browsing-topics=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), " +
	"document-domain=(), encrypted-media=(), fullscreen=(), gamepad=(), geolocation=(), gyroscope=(), " +
	"hid=(), idle-detection=(), interest-cohort=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), " +
	"payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), " +
	"sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()"

// securityHeaders are set on every response, including errors and redirects.
var securityHeaders = map[string]string{
	"Content-Security-Policy":           contentSecurityPolicy,
	"Strict-Transport-Security":         "max-age=63072000; includeSubDomains",
	"X-Content-Type-Options":            "nosniff",
	"X-Frame-Options":                   "DENY",
	"Referrer-Policy":                   "no-referrer",
	"Cross-Origin-Opener-Policy":        "same-origin",
	"Cross-Origin-Embedder-Policy":      "require-corp",
	"Cross-Origin-Resource-Policy":      "same-origin",
	"Permissions-Policy":                permissionsPolicy,
	"X-Robots-Tag":                      "noindex, nofollow, noarchive",
	"X-Permitted-Cross-Domain-Policies": "none",
	"Origin-Agent-Cluster":              "?1",
}

type asset struct {
	contentType string
	body        []byte
	gz          []byte // nil when not worth compressing
	etag        string
	gzETag      string
}

// Server serves an immutable, in-memory set of static assets.
type Server struct {
	assets  map[string]*asset
	modTime time.Time
}

// NewServer loads every allowlisted file from fsys into memory and
// precomputes gzip variants and ETags. Files with other extensions,
// dotfiles and directories are skipped.
func NewServer(fsys fs.FS) (*Server, error) {
	s := &Server{assets: map[string]*asset{}, modTime: time.Now().UTC().Truncate(time.Second)}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") && p != "." {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		ct, ok := contentTypes[strings.ToLower(path.Ext(name))]
		if !ok {
			return nil
		}
		body, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		a := &asset{contentType: ct, body: body, etag: `"` + hex.EncodeToString(sum[:12]) + `"`}
		if compressible[strings.ToLower(path.Ext(name))] && len(body) > 512 {
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			if _, err := zw.Write(body); err != nil {
				return err
			}
			if err := zw.Close(); err != nil {
				return err
			}
			if buf.Len() < len(body) {
				a.gz = buf.Bytes()
				a.gzETag = `"` + hex.EncodeToString(sum[:12]) + `-gz"`
			}
		}
		s.assets["/"+p] = a
		return nil
	})
	if err != nil {
		return nil, err
	}
	if _, ok := s.assets["/index.html"]; !ok {
		return nil, fmt.Errorf("index.html missing from embedded files")
	}
	return s, nil
}

// Paths returns the served paths, sorted (used by tests and startup logging).
func (s *Server) Paths() []string {
	out := make([]string, 0, len(s.assets))
	for p := range s.assets {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func setSecurityHeaders(h http.Header) {
	for k, v := range securityHeaders {
		h.Set(k, v)
	}
}

func plainError(w http.ResponseWriter, code int) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	fmt.Fprintf(w, "%d %s\n", code, http.StatusText(code))
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w.Header())

	// Behind Deploio's ingress TLS terminates upstream; send plain-HTTP
	// clients to HTTPS. The health probe is exempt.
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "http") && r.URL.Path != "/healthz" {
		host := r.Host
		if host == "" || strings.ContainsAny(host, "/\\@ ") {
			plainError(w, http.StatusBadRequest)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusPermanentRedirect)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		plainError(w, http.StatusMethodNotAllowed)
		return
	}

	p := r.URL.Path
	if p == "/healthz" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte("ok\n"))
		}
		return
	}
	if p == "/" {
		p = "/index.html"
	}
	// Reject anything that is not already a clean absolute path; never
	// resolve "..", backslashes or encoded separators.
	if !strings.HasPrefix(p, "/") || path.Clean(p) != p || strings.Contains(p, "\\") || strings.Contains(r.URL.RawPath, "%2") {
		plainError(w, http.StatusNotFound)
		return
	}
	a, ok := s.assets[p]
	if !ok {
		plainError(w, http.StatusNotFound)
		return
	}

	body, etag := a.body, a.etag
	h := w.Header()
	if a.gz != nil {
		h.Set("Vary", "Accept-Encoding")
		if acceptsGzip(r.Header.Get("Accept-Encoding")) {
			body, etag = a.gz, a.gzETag
			h.Set("Content-Encoding", "gzip")
		}
	}
	h.Set("Content-Type", a.contentType)
	h.Set("ETag", etag)
	h.Set("Last-Modified", s.modTime.Format(http.TimeFormat))
	// Revalidate every time: file names are not content-hashed.
	h.Set("Cache-Control", "no-cache")

	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		h.Del("Content-Encoding")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

// acceptsGzip reports whether the Accept-Encoding header allows gzip
// (honouring an explicit q=0).
func acceptsGzip(v string) bool {
	for _, part := range strings.Split(v, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		coding := strings.ToLower(strings.TrimSpace(fields[0]))
		if coding != "gzip" && coding != "*" {
			continue
		}
		q := "1"
		for _, f := range fields[1:] {
			f = strings.TrimSpace(f)
			if strings.HasPrefix(f, "q=") {
				q = strings.TrimPrefix(f, "q=")
			}
		}
		if q == "0" || q == "0.0" || q == "0.00" || q == "0.000" {
			if coding == "gzip" {
				return false
			}
			continue
		}
		return true
	}
	return false
}

func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimSpace(t)
		t = strings.TrimPrefix(t, "W/")
		if t == "*" || t == etag {
			return true
		}
	}
	return false
}

// logging wraps a handler with a minimal access log. It records no IP
// addresses, query strings or headers.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func withAccessLog(next http.Handler, logf func(format string, args ...any)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" {
			return
		}
		p := r.URL.Path
		if len(p) > 120 {
			p = p[:120] + "…"
		}
		logf("%s %q %d %s", r.Method, p, rec.status, time.Since(start).Round(time.Microsecond))
	})
}
