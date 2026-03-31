.PHONY: build compile test precommit

build:
	npx tsc --noEmit

compile:
	npx tsc

test: compile
	python3 tests/bridge_test.py

precommit: build test
