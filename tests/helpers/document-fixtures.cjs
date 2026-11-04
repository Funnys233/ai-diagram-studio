const JSZip = require('jszip');
function assemblePdf(objects) {
  let source = Buffer.from('%PDF-1.4\n'), offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(source.length);
    source = Buffer.concat([source, Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
  });
  const xref = source.length;
  return Buffer.concat([source, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10,'0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}
function pdfFile(text = 'Document reference 73021', { blank = false, pages = 1 } = {}) {
  const escaped = text.replace(/[\\()]/g, '\\$&');
  const content = blank ? '' : `BT /F1 12 Tf 40 740 Td (${escaped}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${3+i} 0 R`).join(' ')}] /Count ${pages} >>`, ...Array.from({length:pages},()=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3+pages} 0 R >> >> /Contents ${4+pages} 0 R >>`), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  return assemblePdf(objects);
}
function scannedPdfFile({ pages = 1, dense = false } = {}) {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(600,800), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,600,800);
  ctx.fillStyle = '#111111'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('SCAN CODE: 84276',55,95);
  ctx.fillStyle = '#e12727'; ctx.beginPath(); ctx.arc(300,300,95,0,2*Math.PI); ctx.fill();
  ctx.fillStyle = '#2055d8'; ctx.fillRect(205,500,190,150);
  if(dense){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,600,800);ctx.fillStyle='#222222';ctx.font='9px sans-serif';for(let i=0;i<72;i++)ctx.fillText('PDF reference row '+i+' modules, processes and diagrams 84276.',22,20+i*10.5);}
  const jpeg = canvas.toBuffer('image/jpeg');
  const content = 'q 600 0 0 800 0 0 cm /Im1 Do Q';
  return assemblePdf(['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${pages} >>`,...Array.from({length:pages},()=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im1 ${3+pages} 0 R >> >> /Contents ${4+pages} 0 R >>`),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 600 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]),`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
}
async function docxFile(text = '项目代号：松林。预算：73021 元。') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  zip.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
module.exports = { pdfFile, docxFile, scannedPdfFile };
