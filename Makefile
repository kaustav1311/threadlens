.PHONY: build test sync serve
build:            ## Build dist/index.html and the artifact fragment
	node scripts/build.mjs
sync:             ## Copy shared lexicons into the Python package
	cp lexicons/*.json python/threadlens/data/
test: sync        ## Run JS and Python tests
	node --test "web/test/*.test.js"
	cd python && python -m pytest -q
serve:            ## Run the self-hosted API on localhost:8000
	cd python && threadlens serve
