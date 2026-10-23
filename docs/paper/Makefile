PAPER := cheguersdb-softwarex

.PHONY: all fonts words clean

all: $(PAPER).pdf

$(PAPER).pdf: $(PAPER).tex references.bib $(wildcard data/*.csv) build_tables.py
	python3 build_tables.py
	latexmk -pdf -interaction=nonstopmode -halt-on-error $(PAPER).tex

fonts: $(PAPER).pdf
	pdffonts $(PAPER).pdf

words:
	texcount -inc -total -sum $(PAPER).tex

clean:
	latexmk -C $(PAPER).tex
