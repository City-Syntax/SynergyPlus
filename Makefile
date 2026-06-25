# SynergyPlus v0.2 — see docs/PROPOSAL.md, docs/CONTRACT.md.
COMPOSE := docker compose -f deploy/docker-compose.yml

.PHONY: help
help: ## Show targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## --- Local stack (Docker Compose: the primary "runs locally" path) ---
.PHONY: up
up: ## Build + start the whole stack (postgres, minio, api, runner, portal, seed)
	$(COMPOSE) up --build -d
	@echo "API   → http://localhost:8090   Portal → http://localhost:3000   MinIO → http://localhost:9001"

.PHONY: up-fg
up-fg: ## Same as up, foreground (see logs)
	$(COMPOSE) up --build

.PHONY: scale
scale: ## Start with N runners (make scale N=4)
	$(COMPOSE) up --build -d --scale runner=$(or $(N),4)

.PHONY: ps
ps: ## Show service status
	$(COMPOSE) ps

.PHONY: logs
logs: ## Tail logs (make logs S=apiserver)
	$(COMPOSE) logs -f $(S)

.PHONY: down
down: ## Stop the stack
	$(COMPOSE) down

.PHONY: clean
clean: ## Stop + delete volumes (fresh DB/storage)
	$(COMPOSE) down -v

.PHONY: seed
seed: ## Re-run the seed job (buckets, sample inputs, demo API key)
	$(COMPOSE) run --rm seed

.PHONY: smoke
smoke: ## End-to-end smoke test against the running stack (uses dev key)
	./deploy/smoke.sh

## --- Go (apiserver/operator) ---
.PHONY: build
build: ## go build everything
	go build ./...

.PHONY: test
test: ## go test
	go test ./...

## --- Version catalog (ADR-0015: config/versions.yaml is the authored source) ---
.PHONY: generate-versions
generate-versions: ## Render config/versions.yaml into the live manifests
	./hack/render-versions.sh

.PHONY: check-versions
check-versions: ## Fail if the committed manifests drift from config/versions.yaml (CI)
	./hack/render-versions.sh --check

## --- Package versions (portal, runner, SDK are released in lockstep) ---
.PHONY: bump-version
bump-version: ## Set ALL package versions (make bump-version V=0.4.0)
	@test -n "$(V)" || { echo "usage: make bump-version V=X.Y.Z" >&2; exit 1; }
	./hack/bump-version.sh $(V)

.PHONY: check-package-versions
check-package-versions: ## Fail if package versions are not all identical (CI)
	./hack/bump-version.sh --check

## --- Kubernetes path (operator + KEDA on the local cluster) ---
.PHONY: keda
keda: ## Install KEDA into the current cluster
	kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml

.PHONY: k8s-deploy
k8s-deploy: ## Apply CRDs, operator, and a sample RunnerPool
	kubectl apply -f config/crd/
	kubectl create namespace synergy-system --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f config/rbac/
	kubectl apply -f config/manager/
	kubectl apply -f config/samples/ || true

.PHONY: k8s-undeploy
k8s-undeploy: ## Remove the k8s deployment
	kubectl delete -f config/manager/ --ignore-not-found
	kubectl delete -f config/crd/ --ignore-not-found

## --- Full local k8s demo on OrbStack (real EnergyPlus, KEDA autoscaling) ---
.PHONY: k8s-images
k8s-images: ## Build images with the tags the manifests expect (OrbStack shares the docker image store)
	docker build -f Dockerfile.operator  -t ghcr.io/synergyplus/operator:latest .
	docker build -f Dockerfile.apiserver -t ghcr.io/synergyplus/apiserver:latest .
	docker build -f runner/Dockerfile    -t ghcr.io/city-syntax/synergyplus-runner:24.1.0 runner/
	docker build -f deploy/seed/Dockerfile -t ghcr.io/synergyplus/seed:latest deploy/seed/

.PHONY: k8s-local
k8s-local: keda k8s-images ## One-command local k8s demo: data plane + operator + seed + RunnerPool
	kubectl apply -f config/crd/
	kubectl create namespace synergy-system --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f config/rbac/
	kubectl apply -f deploy/k8s-local/secret.yaml
	kubectl apply -f deploy/k8s-local/postgres.yaml
	kubectl apply -f deploy/k8s-local/minio.yaml
	kubectl apply -f config/manager/manager.yaml
	kubectl -n synergy-system rollout status deploy/synergyplus-apiserver --timeout=180s
	kubectl apply -f deploy/k8s-local/seed-job.yaml
	kubectl -n synergy-system wait --for=condition=complete job/synergyplus-seed --timeout=180s
	kubectl apply -f deploy/k8s-local/runnerpool-demo.yaml
	@echo ""
	@echo "Up. Forward the API:  kubectl -n synergy-system port-forward svc/synergyplus-apiserver 8090:80"
	@echo "Then:  API=http://localhost:8090 ./deploy/smoke.sh"
	@echo "Watch KEDA scale:  kubectl -n synergy-system get pods -l synergyplus.io/pool=eplus-24-1-0 -w"

.PHONY: k8s-local-down
k8s-local-down: ## Tear down the local k8s demo
	kubectl delete -f deploy/k8s-local/ --ignore-not-found
	kubectl delete -f config/manager/ --ignore-not-found
	kubectl delete -f config/rbac/ --ignore-not-found
	kubectl delete -f config/crd/ --ignore-not-found
