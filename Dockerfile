# syntax=docker/dockerfile:1

# ---- build: vet, test, compile a static binary ----
FROM golang:1.27-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 \
    GOFLAGS=-trimpath \
    GOTOOLCHAIN=local \
    GOPROXY=off
# Standard library only: there is no go.sum and nothing to download.
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN go vet ./... \
 && go test -count=1 ./... \
 && go build -ldflags="-s -w -buildid=" -o /out/budget-lens .

# ---- runtime: distroless, static, non-root, no shell ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/budget-lens /budget-lens
USER nonroot:nonroot
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/budget-lens"]
