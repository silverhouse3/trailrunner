"""
Generate a clean PDF from the TrailRunner Idiot's Guide markdown.
Uses fpdf2 — no LaTeX or wkhtmltopdf needed.

Usage:  python generate_pdf.py
Output: D:\Output_Examples\TrailRunner_Setup_Guide.pdf
"""

import re, os, sys

try:
    from fpdf import FPDF
except ImportError:
    print("Installing fpdf2...")
    os.system(f'"{sys.executable}" -m pip install fpdf2 -q')
    from fpdf import FPDF


def sanitize(text):
    """Replace Unicode chars that latin-1 core fonts can't handle."""
    return (
        text
        .replace("\u2014", "--")   # em dash
        .replace("\u2013", "-")    # en dash
        .replace("\u2018", "'")    # left single quote
        .replace("\u2019", "'")    # right single quote
        .replace("\u201c", '"')    # left double quote
        .replace("\u201d", '"')    # right double quote
        .replace("\u2026", "...")  # ellipsis
        .replace("\u2022", "-")   # bullet
        .replace("\u22c5", ".")   # dot operator
        .replace("\u2192", "->")  # right arrow
        .replace("\u21d2", "=>")  # double right arrow
        .replace("\u2713", "[x]") # check mark
        .replace("\u2717", "[ ]") # cross mark
        .replace("\u22ef", "...") # midline ellipsis
        .replace("\u200b", "")    # zero-width space
        .replace(chr(8226), "-")  # bullet point
    )


class GuidePDF(FPDF):
    def __init__(self):
        super().__init__()
        self.set_auto_page_break(auto=True, margin=20)

    def header(self):
        if self.page_no() > 1:
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(140, 140, 140)
            self.cell(0, 8, "TrailRunner Setup Guide for NordicTrack X32i", align="C")
            self.ln(12)

    def footer(self):
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(140, 140, 140)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")


def parse_markdown(md_path):
    with open(md_path, "r", encoding="utf-8") as f:
        text = f.read()
    return text


def render_pdf(md_text, output_path):
    pdf = GuidePDF()
    pdf.alias_nb_pages()
    pdf.add_page()

    # ── Title page ──
    pdf.set_font("Helvetica", "B", 28)
    pdf.set_text_color(30, 30, 30)
    pdf.ln(40)
    pdf.cell(0, 16, "TrailRunner", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 16)
    pdf.set_text_color(80, 80, 80)
    pdf.cell(0, 10, "Setup Guide for NordicTrack X32i", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(10)
    pdf.set_font("Helvetica", "I", 11)
    pdf.set_text_color(120, 120, 120)
    pdf.cell(0, 8, "The Idiot's Guide", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(30)
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(100, 100, 100)
    pdf.cell(0, 6, "No jargon, no options, no decisions.", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, "Just do exactly what it says.", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(20)

    # What you need box
    pdf.set_fill_color(245, 245, 245)
    pdf.set_draw_color(200, 200, 200)
    x = pdf.get_x()
    y = pdf.get_y()
    pdf.rect(25, y, 160, 32, style="DF")
    pdf.set_xy(30, y + 4)
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(50, 50, 50)
    pdf.cell(0, 6, "You need:", new_x="LMARGIN", new_y="NEXT")
    pdf.set_x(35)
    pdf.set_font("Helvetica", "", 10)
    items = [
        "Your NordicTrack X32i treadmill (plugged in, turned on)",
        "A Windows PC or laptop (on the same WiFi as the treadmill)",
        "20 minutes",
    ]
    for item in items:
        pdf.set_x(35)
        pdf.cell(0, 6, f"  {item}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(10)

    # ── Parse and render body ──
    lines = md_text.split("\n")
    i = 0
    in_code_block = False
    code_buffer = []
    skip_header_section = True  # skip everything before first ---

    while i < len(lines):
        line = lines[i]

        # Skip the top header block (title + "you need" — we did those manually)
        if skip_header_section:
            if line.strip() == "---":
                skip_header_section = False
                # Also skip the next --- if it's a double
            i += 1
            continue

        # Horizontal rule
        if line.strip() == "---":
            pdf.ln(4)
            y = pdf.get_y()
            pdf.set_draw_color(200, 200, 200)
            pdf.line(20, y, 190, y)
            pdf.ln(6)
            i += 1
            continue

        # Code block toggle
        if line.strip().startswith("```"):
            if in_code_block:
                # End code block — render it
                _render_code_block(pdf, code_buffer)
                code_buffer = []
                in_code_block = False
            else:
                in_code_block = True
            i += 1
            continue

        if in_code_block:
            code_buffer.append(line)
            i += 1
            continue

        # Part headers (## PART X:)
        if line.startswith("## PART") or (line.startswith("## ") and any(
            line.upper().startswith(f"## PART {n}") for n in range(1, 10)
        )):
            pdf.add_page()
            pdf.set_font("Helvetica", "B", 20)
            pdf.set_text_color(30, 80, 160)
            title = line.lstrip("#").strip()
            pdf.cell(0, 14, title, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(4)
            i += 1
            continue

        # H2 (## heading)
        if line.startswith("## "):
            pdf.ln(6)
            pdf.set_font("Helvetica", "B", 16)
            pdf.set_text_color(30, 80, 160)
            title = line.lstrip("#").strip()
            pdf.cell(0, 12, title, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(3)
            i += 1
            continue

        # H3 (### heading) — numbered steps
        if line.startswith("### "):
            pdf.ln(5)
            pdf.set_font("Helvetica", "B", 13)
            pdf.set_text_color(40, 40, 40)
            title = line.lstrip("#").strip()
            # Draw a subtle background for step headers
            y = pdf.get_y()
            pdf.set_fill_color(240, 245, 255)
            pdf.rect(10, y - 1, 190, 10, style="F")
            pdf.cell(0, 8, title, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)
            i += 1
            continue

        # Table
        if line.strip().startswith("|"):
            table_lines = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                if not lines[i].strip().startswith("|--") and not lines[i].strip().startswith("| --"):
                    table_lines.append(lines[i])
                i += 1
            _render_table(pdf, table_lines)
            continue

        # Numbered list items (1. 2. 3. etc)
        m = re.match(r"^(\d+)\.\s+(.+)$", line.strip())
        if m:
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(50, 50, 50)
            num = m.group(1)
            content = m.group(2)
            # Number in bold
            x = pdf.get_x()
            pdf.set_font("Helvetica", "B", 10)
            pdf.set_x(15)
            pdf.cell(8, 6, f"{num}.", new_x="RIGHT")
            pdf.set_font("Helvetica", "", 10)
            _write_rich_text(pdf, content, x_start=23)
            pdf.ln(2)
            i += 1
            continue

        # Bullet list items
        if line.strip().startswith("- "):
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(50, 50, 50)
            content = line.strip()[2:]
            indent = (len(line) - len(line.lstrip())) // 2
            x_pos = 18 + indent * 8
            pdf.set_x(x_pos)
            pdf.cell(5, 6, "-")
            _write_rich_text(pdf, content, x_start=x_pos + 5)
            pdf.ln(1)
            i += 1
            continue

        # Regular paragraph
        stripped = line.strip()
        if stripped:
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(50, 50, 50)
            _write_rich_text(pdf, stripped, x_start=15)
            pdf.ln(2)

        i += 1

    pdf.output(output_path)
    return output_path


def _write_rich_text(pdf, text, x_start=15):
    """Write text with basic markdown formatting (bold, inline code, links)."""
    pdf.set_x(x_start)
    max_w = 190 - x_start

    # Split into segments: **bold**, `code`, [text](url), plain
    parts = re.split(r"(\*\*.*?\*\*|`[^`]+`|\[.*?\]\(.*?\))", text)

    for part in parts:
        if not part:
            continue

        # Check if we need a new line
        if pdf.get_x() > 185:
            pdf.ln(5)
            pdf.set_x(x_start)

        if part.startswith("**") and part.endswith("**"):
            inner = part[2:-2]
            pdf.set_font("Helvetica", "B", 10)
            pdf.set_text_color(50, 50, 50)
            w = pdf.get_string_width(inner)
            if pdf.get_x() + w > 195:
                pdf.ln(5)
                pdf.set_x(x_start)
            pdf.cell(w, 6, inner)
            pdf.set_font("Helvetica", "", 10)

        elif part.startswith("`") and part.endswith("`"):
            inner = part[1:-1]
            pdf.set_font("Courier", "", 9)
            pdf.set_text_color(180, 50, 50)
            w = pdf.get_string_width(inner) + 2
            if pdf.get_x() + w > 195:
                pdf.ln(5)
                pdf.set_x(x_start)
            y = pdf.get_y()
            pdf.set_fill_color(245, 240, 240)
            pdf.rect(pdf.get_x(), y, w, 6, style="F")
            pdf.cell(w, 6, inner)
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(50, 50, 50)

        elif part.startswith("["):
            m = re.match(r"\[(.+?)\]\((.+?)\)", part)
            if m:
                label, url = m.group(1), m.group(2)
                pdf.set_text_color(30, 80, 200)
                pdf.set_font("Helvetica", "U", 10)
                w = pdf.get_string_width(label)
                if pdf.get_x() + w > 195:
                    pdf.ln(5)
                    pdf.set_x(x_start)
                pdf.cell(w, 6, label, link=url)
                pdf.set_font("Helvetica", "", 10)
                pdf.set_text_color(50, 50, 50)
            else:
                w = pdf.get_string_width(part)
                if pdf.get_x() + w > 195:
                    pdf.ln(5)
                    pdf.set_x(x_start)
                pdf.cell(w, 6, part)
        else:
            # Plain text — word-wrap manually
            words = part.split(" ")
            for wi, word in enumerate(words):
                w = pdf.get_string_width(word + " ")
                if pdf.get_x() + w > 195:
                    pdf.ln(5)
                    pdf.set_x(x_start)
                pdf.cell(w, 6, word + " " if wi < len(words) - 1 else word)

    pdf.ln(5)


def _render_code_block(pdf, lines):
    """Render a code block with monospace font and grey background."""
    pdf.ln(2)
    pdf.set_font("Courier", "", 9)
    pdf.set_text_color(30, 30, 30)

    y_start = pdf.get_y()
    block_text = "\n".join(lines)
    line_count = len(lines)
    block_h = line_count * 5 + 8

    # Check if we need a page break
    if pdf.get_y() + block_h > 275:
        pdf.add_page()
        y_start = pdf.get_y()

    # Background
    pdf.set_fill_color(240, 240, 240)
    pdf.set_draw_color(210, 210, 210)
    pdf.rect(15, y_start, 180, block_h, style="DF")

    pdf.set_xy(18, y_start + 3)
    for line in lines:
        # Truncate long lines
        if len(line) > 90:
            line = line[:87] + "..."
        pdf.set_x(18)
        pdf.cell(0, 5, line, new_x="LMARGIN", new_y="NEXT")

    pdf.set_y(y_start + block_h + 2)
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(50, 50, 50)
    pdf.ln(2)


def _render_table(pdf, table_lines):
    """Render a markdown table."""
    if not table_lines:
        return

    pdf.ln(3)
    pdf.set_font("Helvetica", "", 9)

    # Parse header and rows
    rows = []
    for line in table_lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        rows.append(cells)

    if not rows:
        return

    num_cols = len(rows[0])
    col_w = 170 / num_cols
    x_start = 20

    for ri, row in enumerate(rows):
        y = pdf.get_y()
        if y > 270:
            pdf.add_page()

        if ri == 0:
            # Header row
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_fill_color(230, 235, 245)
            pdf.set_text_color(30, 30, 30)
        else:
            pdf.set_font("Helvetica", "", 9)
            pdf.set_fill_color(255, 255, 255) if ri % 2 == 0 else pdf.set_fill_color(248, 248, 248)
            pdf.set_text_color(50, 50, 50)

        pdf.set_x(x_start)
        for ci, cell in enumerate(row):
            if ci < num_cols:
                w = col_w
                # Truncate if needed
                text = cell
                while pdf.get_string_width(text) > w - 4 and len(text) > 3:
                    text = text[:-4] + "..."
                pdf.cell(w, 7, text, border=1, fill=True)

        pdf.ln()

    pdf.ln(4)


if __name__ == "__main__":
    md_path = os.path.join(os.path.dirname(__file__), "..", "docs", "IDIOTS_GUIDE.md")
    md_path = os.path.abspath(md_path)

    output = r"D:\Output_Examples\TrailRunner_Setup_Guide.pdf"

    print(f"Reading:  {md_path}")
    md = sanitize(parse_markdown(md_path))
    result = render_pdf(md, output)
    print(f"Created:  {result}")
    print("Done.")
