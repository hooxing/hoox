from pathlib import Path
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw

root=Path(__file__).parent/'fixtures'
document=Document()
document.add_heading('交付文件预览测试',0)
document.add_paragraph('这是第一段内容。用户可以选择这段文字，要求 Agent 修改。')
table=document.add_table(rows=3,cols=3)
for r,row in enumerate(table.rows):
    for c,cell in enumerate(row.cells): cell.text=f'数据 {r+1}-{c+1}'
document.add_page_break()
document.add_heading('第二页：引用测试',1)
document.add_paragraph('请将这里的说明简化，并保留原文件版本。')
document.save(root/'sample.docx')
presentation=Presentation()
for i in range(2):
    slide=presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text=f'季度经营分析 · 第 {i+1} 页'
    textbox=slide.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(2))
    textbox.text_frame.text='华东地区：收入增长 28%\n华南地区：收入增长 16%'
    shape=slide.shapes.add_shape(1, Inches(1), Inches(4), Inches(3), Inches(.8))
    shape.text='重点关注区域'
presentation.save(root/'sample.pptx')
workbook=Workbook(); sheet=workbook.active; sheet.title='销售表'
sheet.append(['区域','收入','同比']); sheet.append(['华东',128,.28]); sheet.append(['华南',116,.16]); sheet.merge_cells('A5:C5'); sheet['A5']='合并区域说明'
sheet2=workbook.create_sheet('明细'); sheet2.append(['编号','说明']);
for i in range(220): sheet2.append([i+1,f'项目{i+1}'])
workbook.save(root/'sample.xlsx')
pdf=canvas.Canvas(str(root/'sample.pdf'))
for i in range(2): pdf.drawString(80,760,f'Preview document page {i+1}'); pdf.drawString(80,720,'Select this sentence and ask the agent to edit it.'); pdf.rect(80,550,300,100); pdf.showPage()
pdf.save()
image=Image.new('RGB',(1200,800),'#f0f4fa'); drawing=ImageDraw.Draw(image); drawing.rectangle((100,100,650,600),fill='#3578ea'); drawing.ellipse((750,200,1100,550),fill='#f2b84b'); image.save(root/'sample.png')
(root/'sample.txt').write_text('第一行：预览文件\n第二行：选择这段内容\n第三行：请修改这一段\n',encoding='utf-8')
(root/'sample.md').write_text('# 项目报告\n\n这里是**重点内容**。\n\n| 区域 | 收入 |\n| --- | --- |\n| 华东 | 128 |\n',encoding='utf-8')
(root/'sample.csv').write_text('区域,说明\n华东,"收入增长,28%"\n华南,116\n',encoding='utf-8')
