from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out=Path('pdf_review_main4')
imgs=[]
for p in sorted(out.glob('slide_*.png')):
    im=Image.open(p).convert('RGB')
    # thumb size
    tw=360; th=int(im.height*tw/im.width)
    im=im.resize((tw,th))
    canvas=Image.new('RGB',(tw,th+35),'white')
    canvas.paste(im,(0,35))
    d=ImageDraw.Draw(canvas)
    d.text((8,8),p.stem.replace('_',' ').upper(),fill=(0,0,0))
    imgs.append(canvas)
# 4 columns x 5 rows
cols=4; rows=(len(imgs)+cols-1)//cols
w=max(i.width for i in imgs); h=max(i.height for i in imgs)
sheet=Image.new('RGB',(cols*w, rows*h),(240,240,240))
for idx,im in enumerate(imgs):
    x=(idx%cols)*w; y=(idx//cols)*h
    sheet.paste(im,(x,y))
sheet.save(out/'contact_sheet.png')
print((out/'contact_sheet.png').resolve(), sheet.size)
