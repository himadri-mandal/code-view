package demo.orders.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import java.util.List;

@Entity
public class Order {
  @Id Long id;
  String customer;
  List<String> items;
  Status status;

  public enum Status { NEW, PAID, CANCELLED }
}
