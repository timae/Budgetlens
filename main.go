// Budget Lens: a static-file server for a CSV budget analyser that runs
// entirely in the browser. The server never receives user data.
package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

//go:embed web
var embedded embed.FS

func listenAddr() (string, error) {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("invalid PORT %q", port)
	}
	return ":" + strconv.Itoa(n), nil
}

func newHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(os.Stderr, "http: ", log.LstdFlags),
	}
}

func run(ctx context.Context) error {
	web, err := fs.Sub(embedded, "web")
	if err != nil {
		return err
	}
	srv, err := NewServer(web)
	if err != nil {
		return err
	}
	addr, err := listenAddr()
	if err != nil {
		return err
	}
	hs := newHTTPServer(addr, withAccessLog(srv, log.Printf))

	errc := make(chan error, 1)
	go func() {
		log.Printf("budget-lens listening on %s (%d files)", addr, len(srv.Paths()))
		errc <- hs.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	log.Print("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return hs.Shutdown(shutdownCtx)
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}
