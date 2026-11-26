"""Remember which automations use employee device-scoped Runner selection."""
from alembic import op
import sqlalchemy as sa

revision = "0095_schedule_device_scope"
down_revision = "0094_merge_proxy_peer_identity"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_schedule", sa.Column("device_bound_runner", sa.Boolean(), nullable=False,
                                           server_default=sa.false()))


def downgrade():
    if op.get_bind().execute(sa.text(
            "SELECT 1 FROM ai_schedule WHERE device_bound_runner LIMIT 1")).first():
        raise RuntimeError("Cannot discard the device scope of existing employee schedules; "
                           "restore a matching application and database backup")
    op.drop_column("ai_schedule", "device_bound_runner")
