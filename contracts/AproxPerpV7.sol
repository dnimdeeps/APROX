// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AproxPerpV7 — Peer-to-Peer Multi-Pair Perpetuals on Arc
 *
 * Oracle change from V6:
 *   V6 used Chronicle Protocol feeds (18-decimal, push-on-1%-move or 1h heartbeat).
 *   This caused PnL to freeze for up to an hour between oracle updates.
 *
 *   V7 uses a standard AggregatorV3Interface feed:
 *     - Testnet: OperatorPriceFeed.sol — the server pushes Pyth Hermes prices every 5s.
 *     - Mainnet: Chainlink Data Streams verifier adapter — sub-second, decentralised.
 *   Both implement the same AggregatorV3Interface so this contract never changes.
 *
 *   Decimal handling: the contract reads decimals() from the feed and normalises
 *   to an internal PRICE_UNIT. OperatorPriceFeed and Chainlink both use 8 decimals,
 *   so PRICE_UNIT = 1e8. All PnL math uses this unit throughout.
 *
 *   Staleness window: 120 seconds.  The feed is pushed every 10s on testnet; 120s
 *   = 12 missed pushes.  Tight enough to prevent stale-price manipulation, generous
 *   enough to survive Render cold starts and Pyth→Coinbase fallback transitions.
 *
 * Everything else (P2P matching, USDC collateral, partial fills, gasless ERC-4337
 * compatibility, liquidation with keeper reward) is unchanged from V6.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ── Oracle interface ──────────────────────────────────────────────────────────

interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function decimals() external view returns (uint8);
}

contract AproxPerpV7 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Price unit ────────────────────────────────────────────────────────────
    // OperatorPriceFeed and Chainlink Data Streams adapters both use 8 decimals.
    int256 public constant PRICE_UNIT = 1e8;

    /**
     * Staleness window — set at deploy time via the constructor.
     *
     * Testnet (Pyth/operator push every 30s):
     *   Pass 120 — tolerates 4 consecutive missed pushes.
     *
     * Mainnet (Chainlink Data Feeds, 0.5% deviation + 24h heartbeat):
     *   Pass 86400 — Chainlink may legitimately not update for up to 24h in a
     *   calm market.  Using 120 here would block all trades for 23h 58m between
     *   updates.  86400 matches the feed's published heartbeat exactly.
     */
    uint256 public immutable MAX_ORACLE_STALENESS;

    // ── Types ─────────────────────────────────────────────────────────────────

    enum OrderStatus { PENDING, ACTIVE, CLOSED, CANCELLED }

    struct Order {
        address trader;
        bool    isLong;
        uint8   leverage;
        uint256 collateral;
        uint256 matchedCollateral;
        uint256 pendingCollateral;
        int256  entryPrice;         // 8-decimal
        uint256 matchedAt;
        uint256 openedAt;
        bytes32 pairId;
        OrderStatus status;
    }

    struct MatchedPair {
        uint256 longOrderId;
        uint256 shortOrderId;
        uint256 lockedCollateral;
        int256  longEntryPrice;     // 8-decimal
        int256  shortEntryPrice;    // 8-decimal
        bool    settled;
    }

    struct TraderStats {
        uint256 totalMatches;
        uint256 totalWins;
        uint256 totalLosses;
        uint256 totalVolume;
        uint256 winStreak;
        uint256 bestStreak;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    address public owner;
    address public feeRecipient;

    mapping(bytes32 => address) public priceFeeds;

    bytes32 public constant PAIR_BTC_USD = keccak256("BTC/USD");
    bytes32 public constant PAIR_ETH_USD = keccak256("ETH/USD");
    bytes32 public constant PAIR_SOL_USD = keccak256("SOL/USD");

    uint256 public nextOrderId;
    uint256 public nextPairId;

    mapping(uint256 => Order)       public orders;
    mapping(uint256 => MatchedPair) public pairs;
    mapping(address => uint256)     public freeBalance;
    mapping(bytes32 => uint256[])   private _pendingQueues;
    mapping(uint256 => uint256[])   public orderPairs;

    // ── Per-wallet leaderboard stats ──────────────────────────────────────────────
    mapping(address => uint256) public totalMatches;   // lifetime matched pairs entered
    mapping(address => uint256) public totalWins;      // closed orders with pnl > 0
    mapping(address => uint256) public totalLosses;    // closed orders with pnl <= 0 (includes liquidations)
    mapping(address => uint256) public totalVolume;    // sum of all lockedCollateral entered (6-dec USDC)
    mapping(address => uint256) public winStreak;      // current consecutive wins
    mapping(address => uint256) public bestStreak;     // all-time best consecutive wins

    uint8 public constant MIN_LEVERAGE = 1;
    uint8 public constant MAX_LEVERAGE = 100;

    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 2000; // 20%
    uint256 public constant KEEPER_REWARD_BPS          = 500;  // 5%

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
    event StatsUpdated(address indexed trader, uint256 totalWins, uint256 totalLosses, uint256 winStreak, uint256 bestStreak);
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
     * @param _usdc               USDC token address
     * @param _owner              Contract owner / admin
     * @param _feeRecipient       Address that receives protocol fees
     * @param _btcFeed            AggregatorV3Interface-compatible BTC/USD price feed
     * @param _ethFeed            Optional ETH/USD feed (pass address(0) to skip)
     * @param _solFeed            Optional SOL/USD feed (pass address(0) to skip)
     * @param _maxOracleStaleness Staleness window in seconds.
     *                            Testnet (Pyth 30s push):  pass 120.
     *                            Mainnet (Chainlink 24h):  pass 86400.
     */
    constructor(
        address _usdc,
        address _owner,
        address _feeRecipient,
        address _btcFeed,
        address _ethFeed,
        address _solFeed,
        uint256 _maxOracleStaleness
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_owner == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_btcFeed == address(0)) revert ZeroAddress();
        if (_maxOracleStaleness == 0) revert ZeroAmount();

        usdc                = IERC20(_usdc);
        owner               = _owner;
        feeRecipient        = _feeRecipient;
        MAX_ORACLE_STALENESS = _maxOracleStaleness;
        nextOrderId         = 1;
        nextPairId          = 1;

        _registerFeed(PAIR_BTC_USD, _btcFeed);
        if (_ethFeed != address(0)) _registerFeed(PAIR_ETH_USD, _ethFeed);
        if (_solFeed != address(0)) _registerFeed(PAIR_SOL_USD, _solFeed);
    }

    function _registerFeed(bytes32 pairId, address feed) internal {
        priceFeeds[pairId] = feed;
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
     * _getPrice — fetch and validate the current price for a pair.
     *
     * Reads latestRoundData() from the registered AggregatorV3Interface feed.
     * Normalises to PRICE_UNIT (1e8) using the feed's own decimals().
     * Reverts on: missing feed, non-positive answer, stale data, stale round.
     */
    function _getPrice(bytes32 pairId) internal view returns (int256 price) {
        address feed = priceFeeds[pairId];
        if (feed == address(0)) revert InvalidPair();

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            AggregatorV3Interface(feed).latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS)
            revert StalePrice(updatedAt, block.timestamp);
        if (answeredInRound < roundId) revert StalePrice(updatedAt, block.timestamp);

        // Normalise to PRICE_UNIT (1e8).
        // OperatorPriceFeed and Chainlink Data Streams adapters already use 8 decimals,
        // so this is a no-op in practice. Kept for correctness against any future feed.
        uint8 dec = AggregatorV3Interface(feed).decimals();
        if (dec == 8) return answer;
        if (dec > 8)  return answer / int256(10 ** uint256(dec - 8));
        return answer * int256(10 ** uint256(8 - dec));
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
            trader:           msg.sender,
            isLong:           isLong,
            leverage:         leverage,
            collateral:       collateral,
            matchedCollateral: 0,
            pendingCollateral: collateral,
            entryPrice:       0,
            matchedAt:        0,
            openedAt:         block.timestamp,
            pairId:           pairId,
            status:           OrderStatus.PENDING
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
        bool   counterIsLong   = !newOrder.isLong;
        bytes32 counterKey     = _queueKey(counterIsLong, newOrder.leverage, pairId);
        uint256[] storage counterQueue = _pendingQueues[counterKey];

        uint256 i = 0;
        while (i < counterQueue.length && newOrder.pendingCollateral > 0) {
            uint256 counterId     = counterQueue[i];
            Order storage counterOrder = orders[counterId];

            if (counterOrder.status == OrderStatus.CANCELLED || counterOrder.pendingCollateral == 0) {
                _removeFromQueue(counterQueue, i);
                continue;
            }

            uint256 fillAmount = newOrder.pendingCollateral < counterOrder.pendingCollateral
                ? newOrder.pendingCollateral
                : counterOrder.pendingCollateral;

            uint256 matchedPairId = nextPairId++;
            uint256 longOrderId   = newOrder.isLong ? newOrderId : counterId;
            uint256 shortOrderId  = newOrder.isLong ? counterId  : newOrderId;

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

        totalMatches[order.trader]++;
        totalVolume[order.trader] += fillAmount;
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

        int256 exitPrice    = _getPrice(order.pairId);
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

        _updateWinStats(msg.sender, totalPnl);

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

        int256  currentPrice   = _getPrice(order.pairId);
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

            uint256 counterShare  = pair.lockedCollateral * 2;
            uint256 counterPayout = counterShare > pairKeeperReward ? counterShare - pairKeeperReward : 0;

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

            _updateWinStats(counterOrder.trader, int256(counterPayout) - int256(pair.lockedCollateral));
        }

        if (order.pendingCollateral > 0) {
            freeBalance[order.trader] += order.pendingCollateral;
            order.pendingCollateral = 0;
        }

        order.status = OrderStatus.CLOSED;
        freeBalance[msg.sender] += keeperReward;

        _updateLossStats(order.trader);

        emit Liquidated(orderId, order.trader, msg.sender, keeperReward);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

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
        // entryPrice is 1e8 — cancels in numerator/denominator, result is 6-dec USDC
        pnl = (int256(pair.lockedCollateral) * int256(uint256(o.leverage)) * delta) / entryPrice;
    }

    function _transferCounterpartyPosition(
        uint256 survivingOrderId,
        bool    neededIsLong,
        uint256 lockedCollateral,
        int256  currentPrice
    ) internal returns (bool transferred, uint256 newPairId) {
        Order storage surviving = orders[survivingOrderId];
        bytes32 queueKey = _queueKey(neededIsLong, surviving.leverage, surviving.pairId);
        uint256[] storage queue = _pendingQueues[queueKey];

        uint256 i = 0;
        while (i < queue.length) {
            uint256 candidateId = queue[i];
            if (candidateId == survivingOrderId) { i++; continue; }

            Order storage candidate = orders[candidateId];

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

    function _updateWinStats(address trader, int256 pnl) internal {
        if (pnl > 0) {
            totalWins[trader]++;
            winStreak[trader]++;
            if (winStreak[trader] > bestStreak[trader]) {
                bestStreak[trader] = winStreak[trader];
            }
        } else {
            totalLosses[trader]++;
            winStreak[trader] = 0;
        }
        emit StatsUpdated(trader, totalWins[trader], totalLosses[trader], winStreak[trader], bestStreak[trader]);
    }

    function _updateLossStats(address trader) internal {
        totalLosses[trader]++;
        winStreak[trader] = 0;
        emit StatsUpdated(trader, totalWins[trader], totalLosses[trader], winStreak[trader], bestStreak[trader]);
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

    function getStats(address trader) external view returns (TraderStats memory) {
        return TraderStats({
            totalMatches: totalMatches[trader],
            totalWins:    totalWins[trader],
            totalLosses:  totalLosses[trader],
            totalVolume:  totalVolume[trader],
            winStreak:    winStreak[trader],
            bestStreak:   bestStreak[trader]
        });
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
     * computeLivePnl — frontend helper. Returns PnL at current oracle price.
     * NOT used in settlement — view only.
     * With 8-decimal prices this returns the same 6-dec USDC units as before.
     */
    function computeLivePnl(uint256 orderId) external view returns (int256 pnl) {
        Order storage order = orders[orderId];
        if (order.matchedCollateral == 0) return 0;

        address feed = priceFeeds[order.pairId];
        if (feed == address(0)) return 0;

        (, int256 rawAnswer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        if (rawAnswer <= 0) return 0;
        // Honour staleness in view context — return 0 rather than revert
        if (block.timestamp - updatedAt > MAX_ORACLE_STALENESS) return 0;

        // Normalise to PRICE_UNIT
        uint8 dec = AggregatorV3Interface(feed).decimals();
        int256 currentPrice = rawAnswer;
        if (dec > 8)  currentPrice = rawAnswer / int256(10 ** uint256(dec - 8));
        else if (dec < 8) currentPrice = rawAnswer * int256(10 ** uint256(8 - dec));

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

    function setPriceFeed(bytes32 pairId, address feed) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        _registerFeed(pairId, feed);
    }
}
