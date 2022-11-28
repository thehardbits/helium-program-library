use crate::{error::ErrorCode, state::*};
use anchor_lang::prelude::*;
use shared_utils::{precise_number::PreciseNumber, signed_precise_number::SignedPreciseNumber};
use std::convert::TryInto;
use time::{Duration, OffsetDateTime};
use voter_stake_registry::state::{DepositEntry, LockupKind, VotingMintConfig};

pub trait OrArithError<T> {
  fn or_arith_error(self) -> Result<T>;
}

impl OrArithError<PreciseNumber> for Option<PreciseNumber> {
  fn or_arith_error(self) -> Result<PreciseNumber> {
    self.ok_or_else(|| ErrorCode::ArithmeticError.into())
  }
}

impl OrArithError<SignedPreciseNumber> for Option<SignedPreciseNumber> {
  fn or_arith_error(self) -> Result<SignedPreciseNumber> {
    self.ok_or_else(|| ErrorCode::ArithmeticError.into())
  }
}

pub const EPOCH_LENGTH: i64 = 24 * 60 * 60;

pub fn current_epoch(unix_timestamp: i64) -> u64 {
  (unix_timestamp / (EPOCH_LENGTH)).try_into().unwrap()
}

pub fn next_epoch_ts(unix_timestamp: i64) -> u64 {
  (current_epoch(unix_timestamp) + 1) * u64::try_from(EPOCH_LENGTH).unwrap()
}

pub fn update_subdao_vehnt(sub_dao: &mut SubDaoV0, curr_ts: i64) {
  sub_dao.vehnt_staked = sub_dao
    .vehnt_staked
    .checked_sub(
      u64::try_from(
        (curr_ts - sub_dao.vehnt_last_calculated_ts)
          .checked_mul(i64::try_from(sub_dao.vehnt_fall_rate).unwrap())
          .unwrap(),
      )
      .unwrap(),
    )
    .unwrap();
  sub_dao.vehnt_last_calculated_ts = curr_ts;
}

pub fn calculate_voting_power(
  d_entry: DepositEntry,
  voting_mint_config: &VotingMintConfig,
  amount_deposited_native: u64,
  amount_initially_locked_native: u64,
  curr_ts: i64,
) -> Result<u64> {
  if voting_mint_config.min_required_lockup_saturation_secs > 0
    && d_entry.lockup.kind == LockupKind::None
  {
    return Ok(0);
  }
  let baseline_vote_weight = voting_mint_config.baseline_vote_weight(amount_deposited_native)?;

  let min_required_locked_vote_weight =
    voting_mint_config.min_required_lockup_vote_weight(amount_initially_locked_native)?;

  let max_locked_vote_weight =
    voting_mint_config.max_extra_lockup_vote_weight(amount_initially_locked_native)?;

  let locked_vote_weight = d_entry.voting_power_locked(
    curr_ts,
    min_required_locked_vote_weight,
    max_locked_vote_weight,
    voting_mint_config.lockup_saturation_secs,
    voting_mint_config.min_required_lockup_saturation_secs,
  )?;

  require_gte!(
    max_locked_vote_weight,
    locked_vote_weight,
    ErrorCode::FailedVotingPowerCalculation,
  );

  baseline_vote_weight
    .checked_add(locked_vote_weight)
    .ok_or_else(|| error!(ErrorCode::FailedVotingPowerCalculation))
}

pub fn create_cron(execution_ts: i64, offset: i64) -> String {
  let expiry_dt = OffsetDateTime::from_unix_timestamp(execution_ts)
    .ok()
    .unwrap()
    .checked_add(Duration::new(offset, 0)) // call purge ix two hours after expiry
    .unwrap();
  let cron = format!(
    "0 {:?} {:?} {:?} {:?} * {:?}",
    expiry_dt.minute(),
    expiry_dt.hour(),
    expiry_dt.day(),
    expiry_dt.month(),
    expiry_dt.year(),
  );
  return cron;
}
