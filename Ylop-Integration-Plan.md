# Ylop Integration Plan: Leverage & Loans for Prediction Market Bots

## Overview

Our bot ecosystem operates on Polymarket (and soon Kalshi) with the following components:

- **OpenClaw Orchestrator**: Central coordinator that manages treasury, Ylop integration, risk limits, and capital distribution
- **Treasury Service**: Tracks USDC balances, collateral status, and profit distribution
- **Market Maker Bot**: Provides liquidity via bid-ask spread capture on Polymarket
- **Arbitrage Bot** (planned): Exploits price differences between Kalshi and Polymarket
- **Other Bots** (planned): Additional strategies leveraging prediction market inefficiencies

Ylop's protocol enables the OpenClaw orchestrator to borrow USDC against active prediction market positions, leverage exposure, and lend USDC for yield. This allows us to maintain positions while accessing liquidity and amplifying capital efficiency across all bots.

> Note: Ylop borrows against active prediction market positions/shares as collateral, not simply idle USDC deposited in Polymarket. Idle USDC can still be lent for yield, but borrowing is position-backed.

## Operational Flows

### 1. Borrow

**Trigger**: When the OpenClaw orchestrator detects that one or more bots need extra capital
**Flow**:

- Orchestrator aggregates capital requests from active bots
- It identifies active positions with sufficient value for collateral
- Orchestrator calls `borrow(amount)` against position collateral via Ylop
- Borrowed USDC goes to the trading wallet and is distributed to one or more bots
- Positions remain open while unlocking capital for new trades

**Risk Management**: The orchestrator monitors liquidation thresholds with temporal LT decay and only borrows against whitelisted, liquid markets.

### 2. Leverage

**Trigger**: When high-conviction opportunities require amplified exposure
**Flow**:

- Bot selects position for leverage amplification
- Calls `leverage(positionSize, leverageRatio)`
- Protocol increases exposure in single flow
- Bot monitors via zkTLS price verification

**Use Case**: Amplify arbitrage positions or market making exposure without additional upfront capital.

### 3. Lend

**Trigger**: When treasury has idle USDC for yield generation
**Flow**:

- Treasury identifies available USDC not needed for trading
- Calls `lend(amount)` to supply to borrower pool
- Earns yield from prediction market activity
- Funds remain available for withdrawal

**Strategy**: Lend during high market activity periods for optimal returns.

### 4. Repay (Implied)

**Trigger**: When liquidity allows debt reduction
**Flow**:

- Bot calculates repayable amount from available funds
- Calls `repay(amount)` to reduce outstanding debt
- Reduces liquidation risk and frees collateral capacity

**Integration**: Assumed available based on borrow description ("repay when it suits you").

### 5. Deleverage (Implied)

**Trigger**: When reducing exposure or managing risk
**Flow**:

- Bot identifies over-leveraged positions
- Calls `deleverage(positionSize, targetRatio)`
- Protocol reduces exposure automatically
- Bot reallocates capital

**Safety**: Use during high volatility or adverse moves.

## Combined Operations

### Liquidity Provision Cycle (Market Maker)

1. **Borrow**: Against existing positions → unlock $500 USDC
2. **Trade**: Use borrowed funds for additional market making
3. **Monitor**: Track positions, LT ratios, temporal decay
4. **Repay**: Return borrowed funds from profits

### Arbitrage Cycle

1. **Leverage**: Amplify position 3x for arb opportunity
2. **Execute**: Capture price discrepancy
3. **Deleverage**: Reduce to base exposure
4. **Repay**: Clear debt with profits

### Orchestrator Capital Routing

- **Request handling**: Each bot sends a capital request to the OpenClaw orchestrator when it needs extra funds.
- **Allocation decision**: The orchestrator evaluates risk, current exposure, and available collateral before using Ylop to borrow.
- **Distribution**: Borrowed funds are distributed to one or more bots according to prioritized needs and leverage limits.
- **Rebalancing**: The orchestrator can also reclaim or reallocate capital as conditions change, supporting deleverage and repayment.

## Technical Requirements

### SDK Features Needed

- **zkTLS Integration**: For trustless price verification of positions
- **Position-Based Collateral**: Use active trades as collateral, not deposited funds
- **Temporal LT Decay**: Automatic risk reduction as markets approach resolution
- **Market Whitelisting**: Only support approved liquid markets
- **Async Processing**: For leverage/deleverage operations

### Integration Points

- **Treasury Service**: Interface for lending operations
- **Bot Coordination**: Monitor position values for borrowing eligibility
- **Risk Engine**: Track LT ratios, liquidation thresholds, portfolio diversification

### Security Considerations

- **Non-Custodial**: Assets remain under smart contract control
- **ZK Proofs**: Verify position prices without revealing sensitive data
- **Redundant Verification**: Multiple zkTLS providers for reliability
- **Emergency Controls**: Force deleverage if needed

## Expected Benefits

- **Capital Efficiency**: Borrow against positions to fund new trades
- **Higher Returns**: Leverage high-conviction positions
- **Yield Generation**: Earn from lending idle capital
- **Risk Management**: Built-in temporal decay and whitelisting

## Next Steps

1. **SDK Review**: Confirm zkTLS integration and position-based operations
2. **Test Integration**: Set up with whitelisted Polymarket positions
3. **Risk Parameters**: Define LT ratios, leverage limits
4. **Monitoring Setup**: Track temporal decay and liquidation risks

Let me know if you need more details on any specific flow or have questions about the integration!
