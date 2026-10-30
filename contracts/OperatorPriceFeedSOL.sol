// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * OperatorPriceFeed — AggregatorV3Interface-compatible price feed
 *
 * The operator wallet pushes a fresh price from Pyth Hermes every ~5 seconds.
 * Any contract that reads via AggregatorV3Interface (latestRoundData / decimals)
 * works without modification — including AproxPerpV7 on testnet and a Chainlink
 * Data Streams verifier adapter on mainnet.
 *
 * Testnet: server pushes Pyth Hermes BTC/USD every 5s.
 * Mainnet: swap the feed address for a Chainlink Data Streams verifier adapter —
 *          same AggregatorV3Interface, no contract redeployment needed.
 *
 * Security:
 *   - Only the designated operator can push prices.
 *   - A price that is older than MAX_STALENESS cannot be read by consumers that
 *     check updatedAt (AproxPerpV7 checks a 60s window).
 *   - roundId increments monotonically; answeredInRound == roundId always.
 */
contract OperatorPriceFeedSOL {

    // ── State ──────────────────────────────────────────────────────────────────

    address public owner;
    address public operator;   // the server wallet authorised to push prices

    uint80  private _roundId;
    int256  private _answer;
    uint256 private _updatedAt;

    uint8   public constant DECIMALS = 8;          // matches Chainlink / Pyth convention
    string  public constant DESCRIPTION = "BTC / USD";

    // ── Events ─────────────────────────────────────────────────────────────────

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event OperatorSet(address indexed oldOperator, address indexed newOperator);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ── Errors ─────────────────────────────────────────────────────────────────

    error NotOperator();
    error NotOwner();
    error ZeroAddress();
    error InvalidPrice();

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _owner, address _operator) {
        if (_owner == address(0) || _operator == address(0)) revert ZeroAddress();
        owner    = _owner;
        operator = _operator;
        _roundId = 0;
    }

    // ── Price push (operator only) ─────────────────────────────────────────────

    /**
     * updateAnswer — push a new price.
     * @param price  8-decimal integer, e.g. 8073539000 = $80,735.39
     */
    function updateAnswer(int256 price) external {
        if (msg.sender != operator) revert NotOperator();
        if (price <= 0) revert InvalidPrice();

        unchecked { _roundId += 1; }
        _answer    = price;
        _updatedAt = block.timestamp;

        emit AnswerUpdated(price, _roundId, block.timestamp);
    }

    // ── AggregatorV3Interface ──────────────────────────────────────────────────

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function description() external pure returns (string memory) {
        return DESCRIPTION;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        roundId        = _roundId;
        answer         = _answer;
        startedAt      = _updatedAt;
        updatedAt      = _updatedAt;
        answeredInRound = _roundId;
    }

    function getRoundData(uint80 rid)
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        // Only current round is stored
        require(rid == _roundId, "round not available");
        roundId        = _roundId;
        answer         = _answer;
        startedAt      = _updatedAt;
        updatedAt      = _updatedAt;
        answeredInRound = _roundId;
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setOperator(address newOperator) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorSet(operator, newOperator);
        operator = newOperator;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
