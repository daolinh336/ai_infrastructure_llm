import fitz, pathlib, json, os
p=pathlib.Path(r'C:\Users\TOAN CAU\Downloads\main (4).pdf')
doc=fitz.open(p)
print('pages', doc.page_count)
print('metadata', doc.metadata)
out=pathlib.Path('pdf_review_main4')
out.mkdir(exist_ok=True)
text_file=out/'slides_text.txt'
with text_file.open('w', encoding='utf-8') as f:
    for i,page in enumerate(doc, start=1):
        f.write(f'\n\n===== SLIDE {i} =====\n')
        txt=page.get_text('text')
        f.write(txt)
        if not txt.strip():
            f.write('[NO EXTRACTABLE TEXT]\n')
print('wrote', text_file.resolve())
for i,page in enumerate(doc, start=1):
    pix=page.get_pixmap(matrix=fitz.Matrix(1.5,1.5), alpha=False)
    pix.save(out/f'slide_{i:02d}.png')
print('rendered to', out.resolve())
