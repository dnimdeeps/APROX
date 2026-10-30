// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AproxPerpV6 — Peer-to-Peer Multi-Pair Perpetuals on Arc
 *
 * Key change from V5: oracle infrastructure replaced.
 *
 * V5 used a custom MockPriceFeed contract that required a server-side
 * operator wallet to push prices on-chain every N seconds.  If the server
 * stopped (rate-limits, crashes, Railway restarts) the feed went stale and
 * every trade reverted.
 *
 * V6 uses Chronicle Protocol price feeds deployed natively on Arc Testnet.
 * Chronicle is a decentralised oracle network whose node operators push prices
 * continuously — no operator wallet, no push loop, no staleness risk from our
 * own infrastructure.
 *
 * Chronicle specifics handled here:
 *   1. Read protection — Chronicle feeds are whitelisted.  On testnet the
 *      SelfKisser contract lets any address whitelist itself permissionlessly.
 *      The constructor calls selfKisser.selfKiss(feed) for every registered
 *      feed so the contract can call latestRoundData() without reverting.
 *   2. 18 decimals — Chronicle always publishes prices with 18 decimal places
 *      (Chainlink uses 8).  All PnL and liquidation math has been updated
 *      from PRICE_DECIMALS = 1e8 to PRICE_DECIMALS = 1e18.
 *   3. AggregatorV3Interface — Chronicle's Scribe implements latestRoundData()
 *      for Chainlink compatibility, so the existing interface is unchanged.
 *
 * Arc Testnet constants (hardcoded, no env var needed):
 *   BTC/USD feed:   0x791CdfE4251B55D89081a45A1cbBEA521767097d  (Chronicle)
 *   SelfKisser:     0xDecd203Ef38DEce4553Fc9fD5C570c26bD34B07F
 *
 * Design principles (unchanged from V5):
 * - Zero protocol reserve: Longs and Shorts are matched against each other.
 *   The contract is pure escrow and settlement — it never risks its own capital.
 * - Partial fills: a position fills up to the available counterpart liquidity.
 *   Any unmatched remainder stays PENDING and can be cancelled at any time.
 * - Peer-to-peer settlement: when either side closes, PnL is computed from the
 *   oracle price and settled between the two locked collateral pools.
 * - Gasless: all calls are compatible with ERC-4337 (no tx.origin checks).
 * - USDC-denominated: all amounts in 6-decimal USDC.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ── Oracle interfaces ─────────────────────────────────────────────────────────

/**
 * Chainlink-compatible interface — Chronicle's Scribe implements this.
 * latestRoundData() returns price with 18 decimals on Chronicle.
 */
interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

/**
 * Chronicle SelfKisser — permissionless whitelist on testnet.
 * Call selfKiss(oracle, who) to whitelist `who` to read from `oracle`.
 * Reference: https://docs.chroniclelabs.org/Developers/Guides/readingFromOracles
 */
interface ISelfKisser {
    function selfKiss(address oracle, address who) external;
}

contract AproxPerpV6 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Chronicle constants (Arc Testnet) ─────────────────────────────────────

    /// Chronicle SelfKisser on Arc Testnet — grants read access to feeds.
    address public constant SELF_KISSER = 0xDecd203Ef38DEce4553Fc9fD5C570c26bD34B07F;

    /**
     * Chronicle uses 18 decimal places for all price feeds.
     * All PnL and liquidation math divides by this constant.
     * (Chainlink uses 1e8; this is the only arithmetic change from V5.)
     */
    int256 public constant PRICE_UNIT = 1e18;

    // ── Types ─────────────────────────────────────────────────────────────────

    enum OrderStatus {
        PENDING,
        ACTIVE,
        CLOSED,
        CANCELLED
    }

    struct Order {
        address trader;
        bool isLong;
        uint8 leverage;
        uint256 collateral;        // 6-dec USDC
        uint256 matchedCollateral; // portion currently matched and active
        uint256 pendingCollateral; // portion awaiting a counterpart
        int256 entryPrice;         // weighted-average entry (18-dec)
        uint256 matchedAt;         // timestamp of first match
        uint256 openedAt;          // timestamp the order was created
        bytes32 pairId;
        OrderStatus status;
    }

    struct MatchedPair {
        uint256 longOrderId;
        uint256 shortOrderId;
        uint256 lockedCollateral; // same value on each side
        int256 longEntryPrice;    // 18-dec
        int256 shortEntryPrice;   // 18-dec
        bool settled;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    address public owner;
    address public feeRecipient;

    mapping(bytes32 => address) public priceFeeds;

    bytes32 public constant PAIR_BTC_USD = keccak256("BTC/USD");
    bytes32 public constant PAIR_ETH_USD = keccak256("ETH/USD");
    bytes32 public constant PAIR_SOL_USD = keccak256("SOL/USD");

    uint256 public nextOrderId;
    uint256 public nextPairId;

    mapping(uint256 => Order) public orders;
    mapping(uint256 => MatchedPair) public pairs;
    mapping(address => uint256) public freeBalance;
    mapping(bytes32 => uint256[]) private _pendingQueues;
    mapping(uint256 => uint256[]) public orderPairs;

    uint8 public constant MIN_LEVERAGE = 1;
    uint8 public constant MAX_LEVERAGE = 100;

    /**
     * Staleness window: 2 hours.
     * Chronicle feeds on Arc Testnet update on ~1% deviation or hourly heartbeat.
     * 2 hours gives one full heartbeat of margin without opening a meaningful
     * oracle-manipulation window.
     */
    uint256 public constant MAX_ORACLE_STALENESS = 7200;

    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 2000; // 20%
    uint256 public constant KEEPER_REWARD_BPS = 500;          // 5%

    // ── Errors ────────────────────────────────────────────────────────────────

    error NotOwner();
    error InvalidLeverage();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidPair();
    error InvalidPrice();
    error StalePrice(uint256 updatedAt, uint256 blockTimestamp);
    error NotTrader();
    error OrderNotPending();
    error OrderNotActive();
    error PositionHealthy();
    error NothingToLiquidate();
    error InsufficientFreeBalance();

    // ── Events ────────────────────────────────────────────────────────────────

    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount);
    event Sent(address indexed from, address indexed to, uint256 amount);
    event OrderOpened(uint256 indexed orderId, address indexed trader, bool isLong, uint8 leverage, uint256 collateral);
    event OrderMatched(uint256 indexed pairId, uint256 indexed longOrderId, uint256 indexed shortOrderId, uint256 lockedCollateral, int256 price);
    event OrderClosed(uint256 indexed orderId, address indexed trader, int256 pnl, uint256 payout);
    event OrderCancelled(uint256 indexed orderId, address indexed trader, uint256 refund);
    event Liquidated(uint256 indexed orderId, address indexed trader, address indexed keeper, uint256 keeperReward);
    event LiquidationReMatched(uint256 indexed liquidatedOrderId, uint256 indexed survivingOrderId, uint256 indexed newPairId, uint256 newLockedCollateral, int256 newEntryPrice);
    event PositionTransferred(uint256 indexed oldPairId, uint256 indexed newPairId, uint256 indexed survivingOrderId, address survivingTrader, int256 newEntryPrice);
    event PriceFeedSet(bytes32 indexed pairId, address indexed feed);
    event FeeRecipientSet(address indexed oldRecipient, address indexed newRecipient);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ── Modifier ──────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _usdc         USDC token address (Arc Testnet: 0x3600...0000)
     * @param _owner        Contract owner / admin
     * @param _feeRecipient Address that receives protocol fees (set to owner for now)
     * @param _btcFeed      Chronicle BTC/USD feed (Arc Testnet: 0x791C...)
     * @param _ethFeed      Chronicle ETH/USD feed on Arc Testnet (pass address(0) to skip)
     * @param _solFeed      Chronicle SOL/USD feed on Arc Testnet (pass address(0) to skip)
     *
     * Chronicle whitelist: the constructor calls selfKisser.selfKiss(feed, address(this))
     * for each non-zero feed so that this contract's address is immediately tolled
     * (whitelisted) to read from the oracle.  Without this, latestRoundData() reverts.
     */
    constructor(
        address _usdc,
        address _owner,
        address _feeRecipient,
        address _btcFeed,
        address _ethFeed,
        address _solFeed
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_owner == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_btcFeed == address(0)) revert ZeroAddress(); // BTC feed required

        usdc = IERC20(_usdc);
        owner = _owner;
        feeRecipient = _feeRecipient;
        nextOrderId = 1;
        nextPairId = 1;

        // Register BTC feed and whitelist this contract on it
        _registerFeed(PAIR_BTC_USD, _btcFeed);

        // ETH and SOL feeds are optional — skip if zero
        if (_ethFeed != address(0)) _registerFeed(PAIR_ETH_USD, _ethFeed);
        if (_solFeed != address(0)) _registerFeed(PAIR_SOL_USD, _solFeed);
    }

    /**
     * _registerFeed — store the feed address and whitelist this contract on it
     * via the Chronicle SelfKisser so latestRoundData() calls succeed.
     */
    function _registerFeed(bytes32 pairId, address feed) internal {
        priceFeeds[pairId] = feed;
        // Whitelist this contract on the Chronicle feed (testnet permissionless)
        ISelfKisser(SELF_KISSER).selfKiss(feed, address(this));
        emit PriceFeedSet(pairId, feed);
    }

    // ── Deposit / Withdraw / Send ─────────────────────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        freeBalance[msg.sender] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (freeBalance[msg.sender] < amount) revert InsufficientFreeBalance();
        freeBalance[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function send(address to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (freeBalance[msg.sender] < amount) revert InsufficientFreeBalance();
        freeBalance[msg.sender] -= amount;
        freeBalance[to] += amount;
        emit Sent(msg.sender, to, amount);
    }

    // ── Oracle helper ─────────────────────────────────────────────────────────

    /**
     * _getPrice — fetch and validate the current oracle price for a pair.
     *
     * Checks:
     *   - Feed is registered for the pair (not address(0))
     *   - Price is positive
     *   - Price is fresh (updatedAt within MAX_ORACLE_STALENESS)
     *   - answeredInRound >= roundId (no stale round data)
     *
     * Returns the raw 18-decimal price integer.
     */
    function _getPrice(bytes32 pairId) internal view returns (int256 price) {
        address feed = priceFeeds[pairId];
        if (feed == address(0)) revert InvalidPair();

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            AggregatorV3Interface(feed).latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) revert StalePrice(updatedAt, block.timestamp);
        if (answeredInRound < roundId) revert StalePrice(updatedAt, block.timestamp);

        return answer;
    }

    // ── Open Order ────────────────────────────────────────────────────────────

    function openOrder(bool isLong, uint8 leverage, uint256 collateral, bytes32 pairId) external nonReentrant {
        if (!_isValidLeverage(leverage)) revert InvalidLeverage();
        if (collateral == 0) revert ZeroAmount();
        if (freeBalance[msg.sender] < collateral) revert InsufficientFreeBalance();

        int256 price = _getPrice(pairId);

        freeBalance[msg.sender] -= collateral;

        uint256 orderId = nextOrderId++;
        orders[orderId] = Order({
            trader: msg.sender,
            isLong: isLong,
            leverage: leverage,
            collateral: collateral,
            matchedCollateral: 0,
            pendingCollateral: collateral,
            entryPrice: 0,
            matchedAt: 0,
            openedAt: block.timestamp,
            pairId: pairId,
            status: OrderStatus.PENDING
        });

        emit OrderOpened(orderId, msg.sender, isLong, leverage, collateral);
        _matchOrder(orderId, price, pairId);
    }

    // ── Matching ──────────────────────────────────────────────────────────────

    function _queueKey(bool isLong, uint8 leverage, bytes32 pairId) internal pure returns (bytes32) {
        return keccak256(abi.encode(isLong, leverage, pairId));
    }

    function _matchOrder(uint256 newOrderId, int256 currentPrice, bytes32 pairId) internal {
        Order storage newOrder = orders[newOrderId];
        bool counterIsLong = !newOrder.isLong;
        bytes32 counterKey = _queueKey(counterIsLong, newOrder.leverage, pairId);
        uint256[] storage counterQueue = _pendingQueues[counterKey];

        uint256 i = 0;
        while (i < counterQueue.length && newOrder.pendingCollateral > 0) {
            uint256 counterId = counterQueue[i];
            Order storage counterOrder = orders[counterId];

            if (counterOrder.status == OrderStatus.CANCELLED || counterOrder.pendingCollateral == 0) {
                _removeFromQueue(counterQueue, i);
                continue;
            }

            uint256 fillAmount = newOrder.pendingCollateral < counterOrder.pendingCollateral
                ? newOrder.pendingCollateral
                : counterOrder.pendingCollateral;

            uint256 matchedPairId = nextPairId++;
            uint256 longOrderId  = newOrder.isLong ? newOrderId : counterId;
            uint256 shortOrderId = newOrder.isLong ? counterId  : newOrderId;

            pairs[matchedPairId] = MatchedPair({
                longOrderId:      longOrderId,
                shortOrderId:     shortOrderId,
                lockedCollateral: fillAmount,
                longEntryPrice:   currentPrice,
                shortEntryPrice:  currentPrice,
                settled:          false
            });

            orderPairs[newOrderId].push(matchedPairId);
            orderPairs[counterId].push(matchedPairId);

            _applyFill(newOrder, fillAmount, currentPrice);
            _applyFill(counterOrder, fillAmount, currentPrice);

            if (counterOrder.pendingCollateral == 0) {
                counterOrder.status = OrderStatus.ACTIVE;
                _removeFromQueue(counterQueue, i);
            } else {
                i++;
            }

            emit OrderMatched(matchedPairId, longOrderId, shortOrderId, fillAmount, currentPrice);
        }

        if (newOrder.pendingCollateral == 0) {
            newOrder.status = OrderStatus.ACTIVE;
        } else {
            newOrder.status = OrderStatus.PENDING;
            _pendingQueues[_queueKey(newOrder.isLong, newOrder.leverage, newOrder.pairId)].push(newOrderId);
        }
    }

    function _applyFill(Order storage order, uint256 fillAmount, int256 price) internal {
        uint256 prevMatched = order.matchedCollateral;
        uint256 newMatched  = prevMatched + fillAmount;
        if (prevMatched == 0) {
            order.entryPrice = price;
        } else {
            order.entryPrice = int256(
                (uint256(order.entryPrice) * prevMatched + uint256(price) * fillAmount) / newMatched
            );
        }
        order.matchedCollateral  = newMatched;
        order.pendingCollateral -= fillAmount;
        if (order.matchedAt == 0) order.matchedAt = block.timestamp;
    }

    function _removeFromQueue(uint256[] storage queue, uint256 index) internal {
        queue[index] = queue[queue.length - 1];
        queue.pop();
    }

    // ── Close Order ───────────────────────────────────────────────────────────

    function closeOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.trader != msg.sender) revert NotTrader();
        if (order.status == OrderStatus.CLOSED || order.status == OrderStatus.CANCELLED) revert OrderNotActive();

        int256 exitPrice = _getPrice(order.pairId);

        uint256 totalPayout = 0;
        int256  totalPnl    = 0;

        uint256[] storage pairIds = orderPairs[orderId];
        for (uint256 i = 0; i < pairIds.length; i++) {
            uint256 pId = pairIds[i];
            MatchedPair storage pair = pairs[pId];
            if (pair.settled) continue;

            uint256 locked    = pair.lockedCollateral;
            int256  pnl       = _computePnl(pair, orderId, exitPrice);
            int256  payoutInt = int256(locked) + pnl;
            uint256 combined  = locked * 2;
            uint256 closerPayout = payoutInt > 0
                ? (uint256(payoutInt) > combined ? combined : uint256(payoutInt))
                : 0;

            totalPnl    += pnl;
            totalPayout += closerPayout;
            pair.settled = true;

            if (order.matchedCollateral >= locked) order.matchedCollateral -= locked;
            else order.matchedCollateral = 0;

            uint256 counterOrderId = pair.longOrderId == orderId ? pair.shortOrderId : pair.longOrderId;
            Order storage counterOrder = orders[counterOrderId];

            (bool transferred, uint256 newPairId) =
                _transferCounterpartyPosition(counterOrderId, order.isLong, locked, exitPrice);

            if (!transferred) {
                if (counterOrder.matchedCollateral >= locked) counterOrder.matchedCollateral -= locked;
                else counterOrder.matchedCollateral = 0;

                uint256 counterCollateral = combined > closerPayout ? combined - closerPayout : 0;
                counterOrder.pendingCollateral += counterCollateral;
                _ensureQueued(counterOrderId);
            }

            _recomputeEntryFromActivePairs(counterOrderId);

            if (_hasActiveUnsettledPair(counterOrderId)) {
                counterOrder.status = OrderStatus.ACTIVE;
            } else if (counterOrder.pendingCollateral > 0) {
                counterOrder.status = OrderStatus.PENDING;
                _ensureQueued(counterOrderId);
            }

            if (transferred) {
                emit PositionTransferred(pId, newPairId, counterOrderId, counterOrder.trader, counterOrder.entryPrice);
            }
        }

        if (order.pendingCollateral > 0) {
            totalPayout += order.pendingCollateral;
            order.pendingCollateral = 0;
        }

        order.matchedCollateral = 0;
        order.entryPrice        = 0;
        order.status            = OrderStatus.CLOSED;
        freeBalance[msg.sender] += totalPayout;

        emit OrderClosed(orderId, msg.sender, totalPnl, totalPayout);
    }

    // ── Cancel Order ──────────────────────────────────────────────────────────

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.trader != msg.sender) revert NotTrader();
        if (order.status == OrderStatus.CLOSED || order.status == OrderStatus.CANCELLED) revert OrderNotPending();
        if (order.pendingCollateral == 0) revert OrderNotPending();

        uint256 refund = order.pendingCollateral;
        order.pendingCollateral = 0;

        if (order.matchedCollateral == 0) order.status = OrderStatus.CANCELLED;

        freeBalance[msg.sender] += refund;
        emit OrderCancelled(orderId, msg.sender, refund);
    }

    // ── Liquidation ───────────────────────────────────────────────────────────

    function liquidate(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.matchedCollateral == 0) revert NothingToLiquidate();

        int256 currentPrice = _getPrice(order.pairId);

        int256  totalPnl       = 0;
        uint256 unsettledMatch = 0;

        uint256[] storage pairIds = orderPairs[orderId];
        for (uint256 i = 0; i < pairIds.length; i++) {
            MatchedPair storage pair = pairs[pairIds[i]];
            if (pair.settled) continue;
            bool   isLong = pair.longOrderId == orderId;
            int256 entry  = isLong ? pair.longEntryPrice : pair.shortEntryPrice;
            int256 delta  = currentPrice - entry;
            if (!isLong) delta = -delta;
            totalPnl      += (int256(pair.lockedCollateral) * int256(uint256(order.leverage)) * delta) / entry;
            unsettledMatch += pair.lockedCollateral;
        }

        if (unsettledMatch == 0) revert NothingToLiquidate();

        int256  remainingInt = int256(unsettledMatch) + totalPnl;
        uint256 remaining    = remainingInt > 0 ? uint256(remainingInt) : 0;

        if (remaining * 10_000 >= unsettledMatch * LIQUIDATION_THRESHOLD_BPS) revert PositionHealthy();

        uint256 uncappedReward = (unsettledMatch * KEEPER_REWARD_BPS) / 10_000;
        bool    capped         = uncappedReward > remaining;
        uint256 keeperReward   = 0;

        for (uint256 i = 0; i < pairIds.length; i++) {
            MatchedPair storage pair = pairs[pairIds[i]];
            if (pair.settled) continue;
            pair.settled = true;

            uint256 counterOrderId = pair.longOrderId == orderId ? pair.shortOrderId : pair.longOrderId;
            Order storage counterOrder = orders[counterOrderId];

            uint256 pairKeeperReward = capped
                ? (remaining * pair.lockedCollateral) / unsettledMatch
                : (pair.lockedCollateral * KEEPER_REWARD_BPS) / 10_000;
            keeperReward += pairKeeperReward;

            uint256 counterShare   = pair.lockedCollateral * 2;
            uint256 counterPayout  = counterShare > pairKeeperReward ? counterShare - pairKeeperReward : 0;

            (bool transferred, uint256 newPairId) =
                _transferCounterpartyPosition(counterOrderId, !counterOrder.isLong, counterPayout, currentPrice);

            if (transferred) {
                _recomputeEntryFromActivePairs(counterOrderId);
                counterOrder.status = OrderStatus.ACTIVE;
                emit LiquidationReMatched(orderId, counterOrderId, newPairId, counterPayout, currentPrice);
            } else {
                counterOrder.pendingCollateral += counterPayout;
                _ensureQueued(counterOrderId);
                counterOrder.status = _hasActiveUnsettledPair(counterOrderId)
                    ? OrderStatus.ACTIVE
                    : OrderStatus.PENDING;
            }
        }

        if (order.pendingCollateral > 0) {
            freeBalance[order.trader] += order.pendingCollateral;
            order.pendingCollateral = 0;
        }

        order.status = OrderStatus.CLOSED;
        freeBalance[msg.sender] += keeperReward;

        emit Liquidated(orderId, order.trader, msg.sender, keeperReward);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * _computePnl — PnL for one side of a matched pair at a given exit price.
     *
     * Formula: locked × leverage × (exitPrice - entryPrice) / entryPrice
     *
     * Both exitPrice and entryPrice are 18-decimal integers (Chronicle).
     * The division by entryPrice cancels the 1e18 scaling so the result is
     * in the same units as lockedCollateral (6-decimal USDC).
     */
    function _computePnl(MatchedPair storage pair, uint256 orderId, int256 exitPrice)
        internal
        view
        returns (int256 pnl)
    {
        bool   isLong     = pair.longOrderId == orderId;
        int256 entryPrice = isLong ? pair.longEntryPrice : pair.shortEntryPrice;
        int256 delta      = exitPrice - entryPrice;
        if (!isLong) delta = -delta;

        Order storage o = orders[orderId];
        // entryPrice is 1e18 so the 1e18 in the numerator and denominator cancel
        pnl = (int256(pair.lockedCollateral) * int256(uint256(o.leverage)) * delta) / entryPrice;
    }

    function _transferCounterpartyPosition(
        uint256 survivingOrderId,
        bool    neededIsLong,
        uint256 lockedCollateral,
        int256  currentPrice
    ) internal returns (bool transferred, uint256 newPairId) {
        Order storage surviving = orders[survivingOrderId];

        // The replacement must be on the SAME side as the closer (neededIsLong),
        // so it faces the surviving counterparty on the opposite side.
        // Queue key: neededIsLong queue at the survivor's leverage + pairId.
        bytes32 queueKey = _queueKey(neededIsLong, surviving.leverage, surviving.pairId);
        uint256[] storage queue = _pendingQueues[queueKey];

        uint256 i = 0;
        while (i < queue.length) {
            uint256 candidateId = queue[i];
            if (candidateId == survivingOrderId) { i++; continue; }

            Order storage candidate = orders[candidateId];

            // Remove stale queue entries
            if (
                candidate.status == OrderStatus.CANCELLED ||
                candidate.status == OrderStatus.CLOSED    ||
                candidate.pendingCollateral == 0          ||
                candidate.leverage != surviving.leverage  ||
                candidate.isLong   != neededIsLong        ||
                candidate.pairId   != surviving.pairId
            ) {
                _removeFromQueue(queue, i);
                continue;
            }

            // Use as much of this candidate as available — support partial fills.
            // If their pending is less than lockedCollateral, match what they have
            // and let the survivor's remainder stay pending for the next replacement.
            uint256 fillAmount = candidate.pendingCollateral < lockedCollateral
                ? candidate.pendingCollateral
                : lockedCollateral;

            newPairId = nextPairId++;
            uint256 longOrderId  = surviving.isLong ? survivingOrderId : candidateId;
            uint256 shortOrderId = surviving.isLong ? candidateId      : survivingOrderId;

            pairs[newPairId] = MatchedPair({
                longOrderId:      longOrderId,
                shortOrderId:     shortOrderId,
                lockedCollateral: fillAmount,
                longEntryPrice:   currentPrice,
                shortEntryPrice:  currentPrice,
                settled:          false
            });

            orderPairs[survivingOrderId].push(newPairId);
            orderPairs[candidateId].push(newPairId);

            _applyFill(candidate, fillAmount, currentPrice);

            if (candidate.pendingCollateral == 0) {
                candidate.status = OrderStatus.ACTIVE;
                _removeFromQueue(queue, i);
            } else {
                candidate.status = OrderStatus.PENDING;
                i++;
            }

            emit OrderMatched(newPairId, longOrderId, shortOrderId, fillAmount, currentPrice);
            // Partial transfer: report success so the survivor is updated correctly.
            // The caller (closeOrder) must handle any remaining unmatched portion.
            return (true, newPairId);
        }
        return (false, 0);
    }

    function _ensureQueued(uint256 orderId) internal {
        Order storage order = orders[orderId];
        bytes32 key = _queueKey(order.isLong, order.leverage, order.pairId);
        uint256[] storage queue = _pendingQueues[key];
        for (uint256 i = 0; i < queue.length; i++) {
            if (queue[i] == orderId) return;
        }
        queue.push(orderId);
    }

    function _hasActiveUnsettledPair(uint256 orderId) internal view returns (bool) {
        uint256[] storage pIds = orderPairs[orderId];
        for (uint256 i = 0; i < pIds.length; i++) {
            if (!pairs[pIds[i]].settled) return true;
        }
        return false;
    }

    function _recomputeEntryFromActivePairs(uint256 orderId) internal {
        Order storage order = orders[orderId];
        uint256[] storage pIds = orderPairs[orderId];
        uint256 totalMatched = 0;
        uint256 weightedSum  = 0;

        for (uint256 i = 0; i < pIds.length; i++) {
            MatchedPair storage pair = pairs[pIds[i]];
            if (pair.settled) continue;
            uint256 locked = pair.lockedCollateral;
            int256  entry  = pair.longOrderId == orderId ? pair.longEntryPrice : pair.shortEntryPrice;
            totalMatched += locked;
            weightedSum  += uint256(entry) * locked;
        }

        order.matchedCollateral = totalMatched;
        order.entryPrice = totalMatched == 0 ? int256(0) : int256(weightedSum / totalMatched);
    }

    function _isValidLeverage(uint8 leverage) internal pure returns (bool) {
        return leverage >= MIN_LEVERAGE && leverage <= MAX_LEVERAGE;
    }

    // ── View functions ────────────────────────────────────────────────────────

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getFreeBalance(address trader) external view returns (uint256) {
        return freeBalance[trader];
    }

    function getPriceFeed(bytes32 pairId) external view returns (address) {
        return priceFeeds[pairId];
    }

    function getPendingQueueLength(bool isLong, uint8 leverage, bytes32 pairId) external view returns (uint256) {
        return _pendingQueues[_queueKey(isLong, leverage, pairId)].length;
    }

    function getPendingQueue(bool isLong, uint8 leverage, bytes32 pairId) external view returns (uint256[] memory) {
        return _pendingQueues[_queueKey(isLong, leverage, pairId)];
    }

    function getOrderPairs(uint256 orderId) external view returns (uint256[] memory) {
        return orderPairs[orderId];
    }

    function getPair(uint256 pairId) external view returns (MatchedPair memory) {
        return pairs[pairId];
    }

    function getMarketDepth(uint8 leverage, bytes32 pairId)
        external
        view
        returns (uint256 pendingLong, uint256 pendingShort)
    {
        uint256[] storage longQ = _pendingQueues[_queueKey(true,  leverage, pairId)];
        for (uint256 i = 0; i < longQ.length; i++) {
            Order storage o = orders[longQ[i]];
            if (o.status != OrderStatus.CANCELLED) pendingLong += o.pendingCollateral;
        }
        uint256[] storage shortQ = _pendingQueues[_queueKey(false, leverage, pairId)];
        for (uint256 i = 0; i < shortQ.length; i++) {
            Order storage o = orders[shortQ[i]];
            if (o.status != OrderStatus.CANCELLED) pendingShort += o.pendingCollateral;
        }
    }

    /**
     * computeLivePnl — off-chain helper for the frontend.
     * Returns live PnL at current Chronicle price. NOT used in settlement.
     */
    function computeLivePnl(uint256 orderId) external view returns (int256 pnl) {
        Order storage order = orders[orderId];
        if (order.matchedCollateral == 0) return 0;

        address feed = priceFeeds[order.pairId];
        if (feed == address(0)) return 0;

        (, int256 currentPrice,,,) = AggregatorV3Interface(feed).latestRoundData();
        if (currentPrice <= 0) return 0;

        uint256[] storage pIds = orderPairs[orderId];
        for (uint256 i = 0; i < pIds.length; i++) {
            MatchedPair storage pair = pairs[pIds[i]];
            if (pair.settled) continue;
            bool   isLong = pair.longOrderId == orderId;
            int256 entry  = isLong ? pair.longEntryPrice : pair.shortEntryPrice;
            int256 delta  = currentPrice - entry;
            if (!isLong) delta = -delta;
            pnl += (int256(pair.lockedCollateral) * int256(uint256(order.leverage)) * delta) / entry;
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientSet(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * setPriceFeed — owner can update or add a feed after deploy.
     * Also whitelists this contract on the new feed via SelfKisser.
     */
    function setPriceFeed(bytes32 pairId, address feed) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        _registerFeed(pairId, feed);
    }
}
