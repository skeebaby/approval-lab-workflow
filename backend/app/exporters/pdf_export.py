from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.domain.validation import validate_workflow
from app.models.workflow import GroupRule, NOfMRule, RoleRule, Workflow


def _safe(value: object) -> str:
    return str(value).encode("latin-1", "replace").decode("latin-1").replace("&", "&amp;").replace("<", "&lt;")


def _rule_summary(rule: object) -> str:
    if isinstance(rule, RoleRule):
        return rule.role
    if isinstance(rule, NOfMRule):
        return f"{rule.n} of {rule.m} approvers"
    if isinstance(rule, GroupRule):
        separator = " AND " if rule.type == "all" else " OR "
        return "(" + separator.join(_rule_summary(child) for child in rule.rules) + ")"
    return "Unknown rule"


def _time_limit(value) -> str:
    if value is None:
        return "Not set"
    unit = "hours" if value.unit == "hours" else "business days"
    return f"{value.amount:g} {unit}"


def export_pdf(workflow: Workflow) -> bytes:
    if workflow.status != "confirmed" or not workflow.confirmed_at:
        raise ValueError("Only a confirmed workflow can be exported.")
    if workflow.unresolved_questions:
        raise ValueError("The confirmed workflow still has unresolved questions.")
    errors = validate_workflow(workflow)
    if errors:
        raise ValueError("The confirmed workflow is no longer valid: " + " ".join(errors))

    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=landscape(letter),
        rightMargin=0.45 * inch,
        leftMargin=0.45 * inch,
        topMargin=0.45 * inch,
        bottomMargin=0.45 * inch,
        title=workflow.name,
        author="ApprovalLab",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle("WorkflowTitle", parent=styles["Title"], alignment=TA_CENTER, fontSize=18)
    small = ParagraphStyle("WorkflowSmall", parent=styles["BodyText"], fontSize=8, leading=10)
    story = [
        Paragraph(_safe(workflow.name), title),
        Spacer(1, 8),
        Paragraph(
            f"<b>Asset:</b> {_safe(workflow.asset_type)} &nbsp;&nbsp; "
            f"<b>Owner:</b> {_safe(workflow.owner)} &nbsp;&nbsp; "
            f"<b>Version:</b> {workflow.version} &nbsp;&nbsp; "
            f"<b>Confirmed:</b> {_safe(workflow.confirmed_at.isoformat())}",
            small,
        ),
        Spacer(1, 12),
    ]
    summary_data = [
        ["Intake", _time_limit(workflow.intake_time_limit), "Final decision", _time_limit(workflow.final_decision_time_limit), "Total", _time_limit(workflow.total_time_limit)],
    ]
    summary = Table(summary_data, colWidths=[0.8 * inch, 1.45 * inch, 1.05 * inch, 1.45 * inch, 0.55 * inch, 1.45 * inch])
    summary.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#edf2e2")),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#30352b")),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d6ddca")),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([summary, Spacer(1, 12)])

    stage_data = [["#", "Review stage", "Time limit", "Approval rule", "Participants"]]
    for stage in workflow.stages:
        participants = [
            f"{participant.role} ({participant.participation})"
            for participant in stage.participants
        ]
        participants.extend(
            f"{condition.role} ({condition.participation}, if {condition.condition})"
            for condition in workflow.conditions
            if condition.stage_id == stage.id
        )
        stage_data.append([
            str(stage.position),
            Paragraph(_safe(stage.name), small),
            _time_limit(stage.time_limit),
            Paragraph(_safe(_rule_summary(stage.approval_rule)), small),
            Paragraph(_safe(", ".join(participants) or "Conditional reviewers only"), small),
        ])
    stages = Table(stage_data, colWidths=[0.35 * inch, 1.7 * inch, 1.1 * inch, 2.5 * inch, 4.4 * inch], repeatRows=1)
    stages.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#263126")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9ddd4")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(stages)

    if workflow.viewers:
        story.extend([Spacer(1, 10), Paragraph(f"<b>People in the know:</b> {_safe(', '.join(workflow.viewers))}", small)])
    if workflow.conditions:
        story.extend([Spacer(1, 10), Paragraph("<b>Conditional routing</b>", styles["Heading3"])])
        for condition in workflow.conditions:
            story.append(Paragraph(
                f"If {_safe(condition.condition)}: {condition.effect} "
                f"{_safe(condition.role)} as {_safe(condition.participation)} in stage "
                f"{condition.stage_id}.",
                small,
            ))
    if workflow.assumptions:
        story.extend([Spacer(1, 10), Paragraph("<b>Assumptions</b>", styles["Heading3"])])
        story.extend(Paragraph(f"• {_safe(item)}", small) for item in workflow.assumptions)
    if workflow.notes:
        story.extend([Spacer(1, 10), Paragraph("<b>Notes</b>", styles["Heading3"])])
        story.extend(Paragraph(f"• {_safe(item)}", small) for item in workflow.notes)

    document.build(story)
    return buffer.getvalue()
