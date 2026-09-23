.PHONY: build test sync serve eval
build:            ## Build dist/index.html and the artifact fragment (fails over the 400 KB budget)
	node scripts/build.mjs
sync:             ## Copy shared lexicons into the Python package
	cp lexicons/*.json python/threadlens/data/
test: sync build  ## Build, then run the JS and Python suites
	node --test "web/test/*.test.js"
	cd python && python -m pytest -q
eval:             ## Score the claim and question gates against the labelled sample
	node scripts/eval.mjs
serve:            ## Run the self-hosted API on localhost:8000
	cd python && threadlens serve
