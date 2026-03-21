.PHONY: build test precommit

build:
	npx tsc --noEmit

test:
	python3 tests/bridge_test.py

precommit: build test
