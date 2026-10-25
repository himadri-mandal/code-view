package demo.orders.api;

import java.util.List;

public record OrderRequest(String customer, List<String> items) {}
