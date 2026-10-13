# Step 1 of the PDF import: read the colour-coded Fixbelegungsplan PDF into cells.json.
# Usage: python scripts/pdf_extract.py <Fixbelegungsplaene.pdf>   (needs: pip install pymupdf)
import pymupdf, sys, re, json, csv
DAYS=["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"]
COL={(255,0,0):"Schule",(0,176,240):"Private Schule",(255,255,0):"Verein/Stiftung",
     (0,176,80):"Private Gruppe",(191,191,191):"nicht verfügbar",(255,255,255):None}
doc=pymupdf.open(sys.argv[1]); S=4
rows_out=[]; halls=[]
for p,page in enumerate(doc):
    words=page.get_text("words")
    title=" ".join(w[4] for w in words if 50<w[1]<70)
    title=re.sub(r"^Fix\w*plan\s+","",title)
    # legend: blue means "Schule extern" on swimming pool page
    legend=" ".join(w[4] for w in words if 485<w[1]<510)
    colmap=dict(COL)
    if "extern" in legend: colmap[(0,176,240)]="Schule extern"
    times=[(w[4],(w[1]+w[3])/2) for w in words if re.match(r"\d\d\.\d\d-\d\d\.\d\d$",w[4])]
    hdrwords={w[4]:w[0] for w in words if w[4] in DAYS and w[1]<86}
    # sub-column boundaries from vertical lines in the 07.00 row
    xs=set()
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0]=="l" and abs(it[1].x-it[2].x)<0.5:
                y0,y1=sorted([it[1].y,it[2].y])
                if y0<92 and y1>96: xs.add(it[1].x)
            elif it[0]=="re" and it[1].width<2.5 and it[1].y0<92 and it[1].y1>96: xs.add(it[1].x0)
    xs=sorted(xs); b=[]
    for x in xs:
        if not b or x-b[-1]>3: b.append(x)
    b=b[1:]  # drop left border of time column -> b[0]=start of Montag
    pix=page.get_pixmap(matrix=pymupdf.Matrix(S,S))
    cols=[]
    for x0,x1 in zip(b,b[1:]):
        c=(x0+x1)/2
        day=max((d for d in DAYS if hdrwords[d]-12<=c), key=lambda d:hdrwords[d])
        season=" ".join(w[4] for w in words if 87<w[1]<99 and x0<=(w[0]+w[2])/2<x1).strip() or None
        cols.append((day,season,x0,x1))
    # text notes inside grid
    notes=[w for w in words if w[0]>b[0]+1 and 99<w[1]<480 and not re.match(r"\d\d\.\d\d-",w[4])]
    halls.append(dict(page=p,hall=title,cols=[(c[0],c[1]) for c in cols]))
    for day,season,x0,x1 in cols:
        for t,yc in times:
            if t=="07.00-07.30" and season: pass
            px=pix.pixel(int((x0+x1)/2*S),int(yc*S))
            # sample a couple of points to avoid text pixels
            samples=[pix.pixel(int((x0+(x1-x0)*f)*S),int(yc*S)) for f in (0.15,0.5,0.85)]
            cat=None; unknown=None
            for s in samples:
                k=min(colmap,key=lambda c:sum((a-b)**2 for a,b in zip(c,s)))
                if sum((a-b)**2 for a,b in zip(k,s))<300:
                    cat=colmap[k]
                    if cat: break
                else: unknown=s
            if unknown and cat is None: print("unknown colour",p,day,t,unknown,file=sys.stderr)
            note=" ".join(w[4] for w in notes if x0<=w[0]<x1 and abs((w[1]+w[3])/2-yc)<7)
            rows_out.append(dict(Halle=title,Tag=day,Saison=season or "",Zeit=t,Kategorie=cat or "frei",Notiz=note))
with open("cells.json","w",encoding="utf-8") as f: json.dump(dict(halls=halls,rows=rows_out),f,ensure_ascii=False)
for h in halls: print(h)
